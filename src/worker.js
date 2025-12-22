// src/worker.js (Final Professional Version)
require('dotenv').config();
const { Worker, Queue } = require('bullmq'); 
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const Event = require('./models/Event'); 

// 1. SAFE CONFIGURATION
const connection = { 
    host: process.env.REDIS_HOST || '127.0.0.1', 
    port: Number(process.env.REDIS_PORT) || 6379 
};

const webhookQueue = new Queue('webhook-queue', { connection });

// Helper: HMAC Signature
function createHmacSignature(payload) {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error('❌ WEBHOOK_SECRET is missing in .env file');
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

// Helper: Parse "Retry-After" Header (RFC 7231)
function getRetryAfterMs(headers) {
    if (!headers || !headers['retry-after']) return null;
    const value = headers['retry-after'];
    
    // Case A: Seconds (e.g., "30")
    if (/^\d+$/.test(value)) {
        return parseInt(value, 10) * 1000;
    }
    
    // Case B: HTTP Date (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
    const date = Date.parse(value);
    if (!isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return null;
}

// Helper: Backoff Strategy
function calculateBackoff(attempts, status, headers) {
    // 1. Honor the Server's instructions first
    if (status === 429) {
        const serverWait = getRetryAfterMs(headers);
        if (serverWait) {
            console.log(`⏳ ALGORITHM: Respecting Retry-After header: ${serverWait}ms`);
            return serverWait;
        }
        console.log('⏳ ALGORITHM: Hit 429 (No Header). Defaulting to 60s.');
        return 60000; 
    }
    
    // 2. Exponential Backoff for 5xx errors
    if (status >= 500) {
        const delay = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s...
        console.log(`📉 ALGORITHM: Server Error (${status}). Delaying ${delay}ms...`);
        return delay;
    }
    
    return 1000; // Default 1s
}

const worker = new Worker('webhook-queue', async (job) => {
    console.log(`Processing Job ${job.id} (Attempt ${job.data.attemptCount || 1})...`);
    const { dbId } = job.data;
    const currentAttempt = job.data.attemptCount || 1;

    try {
        // --- 1. SIGN & SEND ---
        const signature = createHmacSignature(job.data.payload);
        const response = await axios.post(job.data.url, job.data.payload, {
            headers: { 'X-Signature': signature, 'Content-Type': 'application/json' }
        });

        console.log(`✅ Success! Status: ${response.status}`);
        
        if (dbId) {
            await Event.findByIdAndUpdate(dbId, { 
                status: 'COMPLETED',
                $push: { logs: { attempt: currentAttempt, status: response.status, response: 'Success' } }
            });
        }
        return { status: 'COMPLETED', dbId: dbId };

    } catch (error) {
        // --- 2. ROBUST ERROR EXTRACTION ---
        // Fix: Safely handle if error.response is undefined (e.g., DNS error)
        const status = Number(error.response?.status) || 500;
        const headers = error.response?.headers || {};
        console.error(`❌ Failed with Status: ${status}`);

        if (dbId) {
            await Event.findByIdAndUpdate(dbId, { 
                $push: { logs: { attempt: currentAttempt, status: status, response: error.message } }
            });
        }

        // --- 3. STOP ON PERMANENT ERRORS ---
        // 4xx errors (Client Error) means "Don't try again" (unless it's 429 Too Many Requests)
        if (status >= 400 && status < 500 && status !== 429) {
            console.log(`⛔ Client Error (${status}). No retry.`);
            if (dbId) await Event.findByIdAndUpdate(dbId, { status: 'FAILED' });
            return; 
        }

        // --- 4. DLQ LOGIC (MAX RETRIES) ---
        if (currentAttempt >= 5) {
            console.log(`💀 DLQ: Job ${job.id} failed 5 times. Killing it.`);
            
            // Classify why it failed
            const failureType = (status >= 500) ? 'TRANSIENT' : 'PERMANENT';

            if (dbId) {
                await Event.findByIdAndUpdate(dbId, { 
                    status: 'FAILED', 
                    $push: { logs: { 
                        attempt: currentAttempt, 
                        status: 'DLQ', 
                        response: `Max retries reached. Type: ${failureType}`
                    }}
                });
            }
            throw new Error(`Final Failure: Job reached max attempts (${currentAttempt}).`);
        }

        // --- 5. SCHEDULE RETRY ---
        const delay = calculateBackoff(currentAttempt, status, headers);
        
        if (dbId) {
            try {
                console.log(`🔹 UI UPDATE: Marking Job ${dbId} as RETRYING`);
                await Event.findByIdAndUpdate(dbId, { 
                    status: 'RETRYING', 
                    $push: { logs: { 
                        attempt: currentAttempt, 
                        status: status, 
                        response: `Failed with ${status}. Retrying in ${delay/1000}s...`
                    }}
                });
            } catch (dbError) {
                console.error("⚠️ Database update failed, but proceeding with retry:", dbError.message);
            }
        }

        await webhookQueue.add('webhook-job', {
            ...job.data,
            attemptCount: currentAttempt + 1 
        }, {
            delay: delay,
            jobId: `retry-${Date.now()}-${Math.random().toString(36).substring(7)}` 
        });
        
        console.log(`🔄 ALGORITHM: Retry scheduled in ${delay / 1000}s...`);
        return { status: 'RETRYING', dbId: dbId };
    }
}, { connection });

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db')
    .then(() => console.log('✅ Worker connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));