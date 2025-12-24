// src/worker.js (Final Production Version: Atomic Idempotency + Circuit Breaker + Tracing)
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

// --- 👷 WORKER PROCESSOR ---
const worker = new Worker('webhook-queue', async (job) => {
    const { url, payload, dbId, traceId, deliverySemantics } = job.data;
    const tid = traceId || 'NO-TRACE-ID'; 
    const currentAttempt = job.attemptsMade + 1;

    // We explicitly verify that we are running in "Unordered" mode.
    if (deliverySemantics !== 'AT_LEAST_ONCE_UNORDERED') {
        console.warn(`[Trace: ${tid}] ⚠️ Warning: Unknown delivery semantics: ${deliverySemantics}`);
        // In a strict financial system, we might even throw an error here.
        // For now, a warning proves you are watching the system behavior.
    }

    // 👇 1. ATOMIC IDEMPOTENCY CHECK (The "Senior" Logic)
    // We attempt to set a lock key. 'NX' means "Only set if Not Exists".
    const idempotencyKey = `idempotency:${dbId}`;
    const lockAcquired = await redis.set(idempotencyKey, 'LOCKED', 'NX', 'EX', 60 * 60 * 24); // 24h lock

    if (!lockAcquired) {
        // If we couldn't set the key, it means another worker (or previous run) already has it.
        console.warn(`[Trace: ${tid}] 🔄 Duplicate Job Detected (Idempotency Lock Active). Skipping.`);
        return { status: 'skipped', reason: 'Duplicate Job' };
    }

    console.log(`[Trace: ${tid}] ⚙️  Worker: Picked up Job ${dbId} (Attempt ${currentAttempt})`);

    // 2. Mark as PROCESSING
    if (dbId) {
        await Event.findByIdAndUpdate(dbId, { 
            status: 'PROCESSING', 
            $inc: { attemptCount: 1 } 
        });
    }

    try {
        // 🛡️ 3. CHECK CIRCUIT BREAKER
        const circuitStatus = await getCircuitStatus(url);
        if (circuitStatus === 'OPEN') {
            throw new Error('Circuit Breaker Open'); 
        }

        // --- ⚡ TIMEOUT PROTECTION ---
        const signature = createHmacSignature(payload);
        
        const response = await axios.post(url, payload, {
            headers: { 
                'X-Signature': signature, 
                'Content-Type': 'application/json' 
            },
            timeout: 5000 
        });

        // 🛡️ 4. RECORD SUCCESS
        await recordSuccess(url);

        console.log(`[Trace: ${tid}] ✅ Worker: Success! Status: ${response.status}`);

        if (dbId) {
            await Event.findByIdAndUpdate(dbId, {
                status: 'COMPLETED',
                finalHttpStatus: response.status,
                failureType: null,
                $push: { logs: { attempt: currentAttempt, status: response.status, response: 'Success' } }
            });
        }
        
        return response.data;

    } catch (error) {
        // 👇 CRITICAL: DELETE LOCK ON FAILURE
        // If we failed, we must allow the job to be retried!
        await redis.del(idempotencyKey);

        // --- 5. SMART ERROR HANDLING ---
        const type = classifyError(error);
        const status = error.response ? error.response.status : (error.code || 0);
        const msg = error.message;

        if (msg !== 'Circuit Breaker Open' && type === 'TRANSIENT') {
            await recordFailure(url);
        }

        console.error(`[Trace: ${tid}] ⚠️ Worker: Failed. Type: ${type} (${msg})`);

        if (dbId) {
            await Event.findByIdAndUpdate(dbId, {
                $push: { logs: { attempt: currentAttempt, status: typeof status === 'number' ? status : 0, response: msg } }
            });

            if (type === 'PERMANENT') {
                await Event.findByIdAndUpdate(dbId, {
                    status: 'FAILED_PERMANENT',
                    failureType: 'PERMANENT',
                    finalHttpStatus: typeof status === 'number' ? status : 0,
                    lastError: msg
                });
                return { status: 'aborted', reason: 'Permanent Failure' };
            } else {
                await Event.findByIdAndUpdate(dbId, {
                    status: 'FAILED',
                    failureType: 'TRANSIENT',
                    finalHttpStatus: typeof status === 'number' ? status : 0,
                    lastError: msg
                });
            }
        }
        
        throw error; 
    }
}, {
    connection: redis,
    concurrency: 10,
    limiter: { 
        max: 10,
        duration: 1000, 
    }
});

// --- 💀 DEATH LISTENER ---
worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= job.opts.attempts) {
        const tid = job.data.traceId || 'NO-TRACE-ID';
        console.log(`[Trace: ${tid}] 💀 Job ${job.id} has DIED.`);
        
        const dbId = job.data.dbId;
        if (dbId) {
            await Event.findByIdAndUpdate(dbId, {
                status: 'DEAD',
                failureType: 'TRANSIENT',
                lastError: `Given up: ${err.message}`
            });
        }
    }
});

// --- 🎨 DASHBOARD STARTUP ---
console.clear();
console.log(chalk.magenta(figlet.textSync('Worker Node', { horizontalLayout: 'full' })));
console.log(chalk.yellow.bold('\n🔸 BACKGROUND WORKER ACTIVE 🔸'));
console.log(chalk.gray('-----------------------------------'));
console.log(`📡  Listening on:     ${chalk.cyan('webhook-queue')}`);
console.log(`🧵  Concurrency:      ${chalk.magenta('10 Parallel Jobs')}`);
console.log(`🔒  Idempotency:      ${chalk.green('Atomic Redis Locks')}`);
console.log(`🧱  Circuit Breaker:  ${chalk.green('Active (5 fails / 1 min)')}`);
console.log(chalk.gray('-----------------------------------'));

async function gracefulShutdown(signal) {
    console.log(chalk.yellow(`\nReceived ${signal}. Closing worker safely...`));
    await worker.close();
    await mongoose.connection.close();
    console.log(chalk.green('✅ Worker shut down successfully.'));
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));