// src/worker.js (Final Production Version: Atomic Idempotency + Circuit Breaker + Smart Batching)
require('dotenv').config();
const { Worker } = require('bullmq'); 
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const figlet = require('figlet');
const chalk = require('chalk');
const redis = require('./redis'); 
const Event = require('./models/Event'); 
const { getCircuitStatus, recordFailure, recordSuccess } = require('./circuitBreaker');

// --- ⚡ BATCHING CONFIGURATION (The 10/10 Upgrade) ---
const BATCH_SIZE = 500;        // Max operations to hold in memory
const FLUSH_INTERVAL = 2000;   // Max time to wait (2 seconds)
let bulkOps = [];              // The Buffer
let flushTimer = null;         // The Timer

// --- 🔐 SECURITY HELPER ---
function createHmacSignature(payload) {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error('❌ WEBHOOK_SECRET is missing in .env file');
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

// --- 🧠 CLASSIFICATION HELPER ---
function classifyError(error) {
    if (error.message === 'Circuit Breaker Open') return 'TRANSIENT';
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'TRANSIENT';
    if (!error.response) return 'TRANSIENT'; 
    const status = error.response.status;
    if (status === 429 || status >= 500) return 'TRANSIENT'; 
    if (status >= 400) return 'PERMANENT'; 
    return 'TRANSIENT'; 
}

// --- 🔌 CONNECT MONGO ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db')
    .then(() => console.log('✅ Worker connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- ⚡ BATCH FLUSHER (The Engine) ---
async function flushToMongo() {
    if (bulkOps.length === 0) return;

    // 1. Swap buffer immediately (Concurrency Safety)
    const opsToExecute = [...bulkOps];
    bulkOps = [];

    try {
        // 2. The Magic: Execute hundreds of updates in ONE command
        await Event.bulkWrite(opsToExecute);
        // console.log(chalk.gray(`💾 Bulk flushed ${opsToExecute.length} updates to Mongo`));
    } catch (err) {
        console.error('❌ Bulk Write Failed:', err);
        // In a real banking app, you would dump 'opsToExecute' to a 'failed_logs.json' file here to retry later.
    }
}

// Start the safety timer
setInterval(flushToMongo, FLUSH_INTERVAL);

// Helper to push to buffer safely
function addToBatch(op) {
    bulkOps.push(op);
    if (bulkOps.length >= BATCH_SIZE) {
        flushToMongo();
    }
}

// --- 👷 WORKER PROCESSOR ---
const worker = new Worker('webhook-queue', async (job) => {
    const { url, payload, dbId, traceId, deliverySemantics } = job.data;
    const tid = traceId || 'NO-TRACE-ID'; 
    const currentAttempt = job.attemptsMade + 1;

    if (deliverySemantics !== 'AT_LEAST_ONCE_UNORDERED') {
        // console.warn(`[Trace: ${tid}] ⚠️ Warning: Unknown delivery semantics`);
    }

    // 👇 1. ATOMIC IDEMPOTENCY CHECK
    const idempotencyKey = `idempotency:${dbId}`;
    const lockAcquired = await redis.set(idempotencyKey, 'LOCKED', 'NX', 'EX', 60 * 60 * 24); 

    if (!lockAcquired) {
        // console.warn(`[Trace: ${tid}] 🔄 Duplicate Job Detected. Skipping.`);
        return { status: 'skipped', reason: 'Duplicate Job' };
    }

    // console.log(`[Trace: ${tid}] ⚙️  Worker: Picked up Job ${dbId}`);

    // ⚡ BATCH UPGRADE: Replaces await Event.findByIdAndUpdate()
    if (dbId) {
        addToBatch({
            updateOne: {
                filter: { _id: dbId },
                update: { status: 'PROCESSING', $inc: { attemptCount: 1 } }
            }
        });
    }

    try {
        // 🛡️ 3. CHECK CIRCUIT BREAKER
        const circuitStatus = await getCircuitStatus(url);
        if (circuitStatus === 'OPEN') throw new Error('Circuit Breaker Open'); 

        // --- ⚡ TIMEOUT PROTECTION ---
        const signature = createHmacSignature(payload);
        const response = await axios.post(url, payload, {
            headers: { 'X-Signature': signature, 'Content-Type': 'application/json' },
            timeout: 5000 
        });

        // 🛡️ 4. RECORD SUCCESS
        await recordSuccess(url);
        // console.log(`[Trace: ${tid}] ✅ Worker: Success!`);

        // ⚡ BATCH UPGRADE: Success Log
        if (dbId) {
            addToBatch({
                updateOne: {
                    filter: { _id: dbId },
                    update: {
                        status: 'COMPLETED',
                        finalHttpStatus: response.status,
                        failureType: null,
                        $push: { logs: { attempt: currentAttempt, status: response.status, response: 'Success' } }
                    }
                }
            });
        }
        
        return response.data;

    } catch (error) {
        // 👇 CRITICAL: DELETE LOCK ON FAILURE
        await redis.del(idempotencyKey);

        const type = classifyError(error);
        const status = error.response ? error.response.status : (error.code || 0);
        const msg = error.message;

        if (msg !== 'Circuit Breaker Open' && type === 'TRANSIENT') {
            await recordFailure(url);
        }

        // console.error(`[Trace: ${tid}] ⚠️ Worker: Failed. Type: ${type}`);

        // ⚡ BATCH UPGRADE: Failure Log
        if (dbId) {
            const updateDoc = {
                $push: { logs: { attempt: currentAttempt, status: typeof status === 'number' ? status : 0, response: msg } }
            };

            // If PERMANENT, we also update the main status
            if (type === 'PERMANENT') {
                updateDoc.status = 'FAILED_PERMANENT';
                updateDoc.failureType = 'PERMANENT';
                updateDoc.finalHttpStatus = typeof status === 'number' ? status : 0;
                updateDoc.lastError = msg;
            } else {
                updateDoc.status = 'FAILED'; // Just for now, BullMQ will retry
                updateDoc.failureType = 'TRANSIENT';
                updateDoc.lastError = msg;
            }

            addToBatch({
                updateOne: {
                    filter: { _id: dbId },
                    update: updateDoc
                }
            });
        }

        if (type === 'PERMANENT') return { status: 'aborted', reason: 'Permanent Failure' };
        throw error; 
    }
}, {
    connection: redis,
    concurrency: 200, // "God Mode" Concurrency
    limiter: { max: 50, duration: 1000 }
});


// --- 💀 DEATH LISTENER (DLQ Handler) ---
worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= job.opts.attempts) {
        const tid = job.data.traceId || 'NO-TRACE-ID';
        // console.log(chalk.red.bold(`[Trace: ${tid}] 💀 Job ${job.id} has DIED -> DLQ`));

        // ⚡ BATCH UPGRADE: Even DLQ updates are batched for consistency
        const dbId = job.data.dbId;
        if (dbId) {
            addToBatch({
                updateOne: {
                    filter: { _id: dbId },
                    update: {
                        status: 'DEAD',
                        failureType: 'PERMANENT',
                        lastError: `Max Retries Reached: ${err.message}`
                    }
                }
            });
        }
    }
});

// --- 🎨 DASHBOARD STARTUP ---
console.clear();
console.log(chalk.magenta(figlet.textSync('Worker Node', { horizontalLayout: 'full' })));
console.log(chalk.yellow.bold('\n🔸 BACKGROUND WORKER ACTIVE (BATCHED MODE) 🔸'));
console.log(chalk.gray('-----------------------------------'));
console.log(`📡  Listening on:     ${chalk.cyan('webhook-queue')}`);
console.log(`🧵  Concurrency:      ${chalk.magenta('50 Parallel Jobs')}`);
console.log(`💾  Write Strategy:   ${chalk.green('BulkWrite (Batch: 500)')}`);
console.log(chalk.gray('-----------------------------------'));

async function gracefulShutdown(signal) {
    console.log(chalk.yellow(`\nReceived ${signal}. Closing worker safely...`));
    
    // ⚡ CRITICAL: Flush remaining logs before dying
    console.log('💾 Flushing remaining DB logs...');
    await flushToMongo(); 

    await worker.close();
    await mongoose.connection.close();
    console.log(chalk.green('✅ Worker shut down successfully.'));
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));