// src/worker.js
require('dotenv').config();
const { Worker } = require('bullmq'); 
const mongoose = require('mongoose');
const axios = require('axios');
const figlet = require('figlet');
const chalk = require('chalk');

// Infrastructure
const redis = require('./redis'); 
const Event = require('./models/Event'); 

// Services & Utils
const { getCircuitStatus, recordFailure, recordSuccess } = require('./circuitBreaker');
const { addToBatch } = require('./batchProcessor');

const { safeHttpStatus, createHmacSignature, classifyError } = require('./utils/workerUtils');
const { acquireIdempotencyLock, releaseIdempotencyLock } = require('./services/lockService');

// --- 🔌 CONNECT MONGO ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db')
    .then(() => console.log('✅ Worker connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- 👷 WORKER PROCESSOR ---
const worker = new Worker('webhook-queue', async (job) => {
    const { url, payload, dbId, traceId, deliverySemantics } = job.data;
    const tid = traceId || 'NO-TRACE-ID'; 
    const currentAttempt = job.attemptsMade + 1;

    // 1. Validate Delivery Semantics
    if (deliverySemantics !== 'AT_LEAST_ONCE_UNORDERED') {
        console.warn(`[Trace: ${tid}] ⚠️ Warning: Unknown semantics: ${deliverySemantics}`);
    }

    // 2. Idempotency Check
    const isLocked = await acquireIdempotencyLock(redis, dbId);
    if (!isLocked) {
        console.warn(`[Trace: ${tid}] 🔄 Duplicate Job Detected. Skipping.`);
        return { status: 'skipped', reason: 'Duplicate Job' };
    }

    // 3. Update Status to PROCESSING
    if (dbId) {
        await Event.findByIdAndUpdate(dbId, { 
            status: 'PROCESSING', 
            $inc: { attemptCount: 1 } 
        });
    }

    console.log(`[Trace: ${tid}] ⚙️  Worker: Picked up Job ${dbId}`);

    try {
        // 4. Circuit Breaker Check
        if (await getCircuitStatus(url) === 'OPEN') {
            throw new Error('Circuit Breaker Open');
        }

        // 5. Prepare & Send Request
        const signature = createHmacSignature(payload, process.env.WEBHOOK_SECRET);
        const response = await axios.post(url, payload, {
            headers: { 
                'X-Signature': signature, 
                'Content-Type': 'application/json' 
            },
            timeout: 5000 
        });

        // 6. Handle Success
        await recordSuccess(url);
        console.log(`[Trace: ${tid}] ✅ Success: ${response.status}`);

        if (dbId) {
            addToBatch({
                dbId,
                status: 'COMPLETED',
                httpStatus: safeHttpStatus(response.status),
                logEntry: { 
                    attempt: currentAttempt, 
                    status: safeHttpStatus(response.status), 
                    response: 'Success' 
                }
            });
        }
        
        return response.data;

    } catch (error) {
        // 7. Handle Failure
        await releaseIdempotencyLock(redis, dbId); // Allow retries

        const type = classifyError(error);
        const msg = error.message || String(error);
        const httpStatus = safeHttpStatus(error.response?.status);
        const errorCode = error.code ? String(error.code) : null;

        if (msg !== 'Circuit Breaker Open' && type === 'TRANSIENT') {
            await recordFailure(url);
        }

        console.error(`[Trace: ${tid}] ⚠️ Failed: ${type} (${msg})`);

        if (dbId) {
            addToBatch({
                dbId,
                status: (type === 'PERMANENT') ? 'FAILED_PERMANENT' : 'FAILED',
                failureType: (type === 'PERMANENT') ? 'PERMANENT' : 'TRANSIENT',
                httpStatus,
                errorCode,
                lastError: msg,
                logEntry: { attempt: currentAttempt, status: httpStatus, response: msg }
            });
        }

        if (type === 'PERMANENT') {
            return { status: 'aborted', reason: 'Permanent Failure' };
        }

        throw error; // Triggers BullMQ retry
    }
}, {
    connection: redis,
    concurrency: 50,
    limiter: { max: 50, duration: 1000 }
});

// --- 💀 DEATH LISTENER ---
worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= job.opts.attempts) {
        console.log(chalk.red.bold(`[Trace: ${job.data.traceId}] 💀 Job ${job.id} DIED -> DLQ`));
        if (job.data.dbId) {
            await Event.findByIdAndUpdate(job.data.dbId, {
                status: 'DEAD',
                failureType: 'PERMANENT',
                lastError: `Max Retries Reached: ${err.message}`
            });
        }
    }
});

// --- 🎨 STARTUP LOGS ---
console.clear();
console.log(chalk.magenta(figlet.textSync('Worker Node')));
console.log(chalk.yellow.bold('\n🔸 BACKGROUND WORKER ACTIVE 🔸'));
// ... (rest of your logs)

// --- 🛑 SHUTDOWN ---
process.on('SIGINT', async () => {
    await worker.close();
    await mongoose.connection.close();
    process.exit(0);
});