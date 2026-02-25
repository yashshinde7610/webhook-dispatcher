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
const { addToBatch, shutdownBatchProcessor } = require('./batchProcessor');

const { safeHttpStatus, createHmacSignature, classifyError } = require('./utils/workerUtils');

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

    // 3. Update Status to PROCESSING
// ... inside the worker processor ...

    // 3. Create OR Update Status to PROCESSING (Upsert Logic)
    if (dbId) {
        await Event.findByIdAndUpdate(
            dbId, 
            { 
                // 👇 $setOnInsert ONLY triggers if the document doesn't exist yet (1st attempt)
                $setOnInsert: {
                    _id: dbId, // Explicitly set the ID we generated in the API
                    traceId: tid,
                    source: job.data.source || 'API',
                    payload: payload,
                    url: url,
                    deliverySemantics: deliverySemantics || 'AT_LEAST_ONCE_UNORDERED'
                },
                // 👇 $set and $inc trigger every time (including retries)
                $set: { status: 'PROCESSING' },
                $inc: { attemptCount: 1 } 
            },
            { upsert: true, new: true } // Upsert creates the doc if missing
        );
    }

    if (process.env.NODE_ENV !== 'production') {
        console.log(`[Trace: ${tid}] ⚙️  Worker: Picked up Job ${dbId}`);
    }
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
        if (process.env.NODE_ENV !== 'production') {
        console.log(`[Trace: ${tid}] ✅ Success: ${response.status}`);
    }

        if (dbId) {
            await addToBatch({
                dbId,
                status: 'COMPLETED',
                attemptCount: currentAttempt,
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

        const type = classifyError(error);
        const msg = error.message || String(error);
        const httpStatus = safeHttpStatus(error.response?.status);
        const errorCode = error.code ? String(error.code) : null;

        if (msg !== 'Circuit Breaker Open' && type === 'TRANSIENT') {
            await recordFailure(url);
        }

        console.error(`[Trace: ${tid}] ⚠️ Failed: ${type} (${msg})`);

        if (dbId) {
            await addToBatch({
                dbId,
                status: (type === 'PERMANENT') ? 'FAILED_PERMANENT' : 'FAILED',
                attemptCount: currentAttempt,
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

// --- 🛑 GRACEFUL SHUTDOWN ---
async function gracefulShutdown(signal) {
    console.log(chalk.yellow.bold(`\n🛑 Received ${signal}. Starting graceful shutdown...`));
    
    try {
        // 1. Stop accepting new jobs from Redis immediately
        console.log(chalk.gray('1. Pausing BullMQ Worker...'));
        await worker.close(); 
        
        // 2. 🚨 THE FIX: Flush the remaining items in the Batch Processor buffer to MongoDB
        console.log(chalk.gray('2. Flushing Batch Processor Buffer...'));
        await shutdownBatchProcessor();
        
        // 3. Safely disconnect from MongoDB ONLY AFTER the buffer is flushed
        console.log(chalk.gray('3. Closing MongoDB Connection...'));
        await mongoose.connection.close();
        
        console.log(chalk.green('✅ Shutdown complete. Goodbye!'));
        process.exit(0);
    } catch (err) {
        console.error(chalk.red('💥 Error during shutdown:'), err);
        process.exit(1);
    }
}

// Listen for both Ctrl+C (Local) and Docker/Kubernetes termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
