// src/worker.js (Final Production Version: Security + Safety + Dashboard + Tracing)
require('dotenv').config();
const { Worker } = require('bullmq'); 
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const figlet = require('figlet');
const chalk = require('chalk');
const redis = require('./redis'); 
const Event = require('./models/Event'); 

// --- 🔐 SECURITY HELPER ---
function createHmacSignature(payload) {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error('❌ WEBHOOK_SECRET is missing in .env file');
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

// --- 🧠 CLASSIFICATION HELPER ---
function classifyError(error) {
    // 1. TIMEOUTS (Explicitly handle hanging requests)
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return 'TRANSIENT';
    }

    if (!error.response) return 'TRANSIENT'; // Network/DNS -> Retry
    
    const status = error.response.status;
    if (status === 429) return 'TRANSIENT';  // Rate Limit -> Retry
    if (status >= 500) return 'TRANSIENT';   // Server Crash -> Retry
    if (status >= 400) return 'PERMANENT';   // 404/401 -> Stop

    return 'TRANSIENT'; // Default safe option
}

// --- 🔌 CONNECT MONGO ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db')
    .then(() => console.log('✅ Worker connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- 👷 WORKER PROCESSOR ---
const worker = new Worker('webhook-queue', async (job) => {
    // 1. EXTRACT DATA & TRACE ID (The "Digital Thread")
    const { url, payload, dbId, traceId } = job.data;
    const tid = traceId || 'NO-TRACE-ID'; 
    const currentAttempt = job.attemptsMade + 1;

    console.log(`[Trace: ${tid}] ⚙️  Worker: Picked up Job ${dbId} (Attempt ${currentAttempt})`);

    // 2. Mark as PROCESSING
    if (dbId) {
        await Event.findByIdAndUpdate(dbId, { 
            status: 'PROCESSING', 
            $inc: { attemptCount: 1 } 
        });
    }

    try {
        // --- ⚡ TIMEOUT PROTECTION ---
        const signature = createHmacSignature(payload);
        
        const response = await axios.post(url, payload, {
            headers: { 
                'X-Signature': signature, 
                'Content-Type': 'application/json' 
            },
            timeout: 5000 // 5s Safety Switch
        });

        // 3. SUCCESS!
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
        // --- 4. SMART ERROR HANDLING ---
        const type = classifyError(error);
        const status = error.response ? error.response.status : (error.code || 0);
        const msg = error.message;

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
                // Stop retrying
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
        
        // Throw error to trigger BullMQ retry (only for TRANSIENT)
        throw error; 
    }
}, {
    connection: redis,
    concurrency: 10,
    limiter: { 
        max: 1,          // 1 job...
        duration: 2000,  // ...every 2 seconds (Matches your webhook.site limit)
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
console.log(`🛡️   Retry Policy:     ${chalk.green('Smart Backoff (5x)')}`);
console.log(`⚡  Timeout Safety:   ${chalk.red('5000ms Limit')}`);
console.log(chalk.gray('-----------------------------------'));

// --- 🛑 GRACEFUL SHUTDOWN ---
async function gracefulShutdown(signal) {
    console.log(chalk.yellow(`\nReceived ${signal}. Closing worker safely...`));
    await worker.close();
    await mongoose.connection.close();
    console.log(chalk.green('✅ Worker shut down successfully.'));
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));