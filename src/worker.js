// src/worker.js (The "Algorithm" Version)
require('dotenv').config(); // <--- 1. LOAD ENV VARIABLES
const { Worker, Queue } = require('bullmq'); 
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const Event = require('./models/Event'); 

// 2. USE ENV VARIABLES FOR REDIS
const connection = { 
    host: process.env.REDIS_HOST || '127.0.0.1', 
    port: process.env.REDIS_PORT || 6379 
};

// Create a Queue instance so we can manually re-add jobs
const webhookQueue = new Queue('webhook-queue', { connection });

// Helper: HMAC Signature
function createHmacSignature(payload) {
    // 3. USE ENV VARIABLE FOR SECRET
    const secret = process.env.WEBHOOK_SECRET;
    // Security Check: Fail if secret is missing
    if (!secret) throw new Error('❌ WEBHOOK_SECRET is missing in .env file');
    
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

// Helper: Calculate Custom Backoff
function calculateBackoff(attempts, status) {
    if (status === 429) {
        console.log('⏳ ALGORITHM: Hit Rate Limit (429). Delaying 60s...'); 
        return 60000; 
    }
    if (status >= 500) {
        const delay = Math.pow(2, attempts) * 1000;
        console.log(`📉 ALGORITHM: Server Error (${status}). Delaying ${delay}ms...`);
        return delay;
    }
    return 1000;
}

const worker = new Worker('webhook-queue', async (job) => {
    console.log(`Processing Job ${job.id} (Attempt ${job.data.attemptCount || 1})...`);
    const { dbId } = job.data;
    
    // Track attempts manually since we disabled BullMQ's auto-retry
    const currentAttempt = job.data.attemptCount || 1;

    try {
        // --- CHAOS MONKEY: PERMANENT FAILURE MODE ---
        // Uncomment the line below to simulate a crash
        // throw { response: { status: 500 }, message: "Simulated Server Crash" }; 

        // 1. Sign & Send
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
        const status = error.response ? error.response.status : 500; // Default to 500 if network fails
        console.error(`❌ Failed with Status: ${status}`);

        // 3. Update DB Log
        if (dbId) {
            await Event.findByIdAndUpdate(dbId, { 
                $push: { logs: { attempt: currentAttempt, status: status, response: error.message } }
            });
        }

        // --- THE ALGORITHM: CUSTOM RETRY LOGIC ---
        
        // Rule A: Don't retry Client Errors (400-499), EXCEPT 429
        if (status >= 400 && status < 500 && status !== 429) {
            console.log(`⛔ Client Error (${status}). No retry.`);
            if (dbId) await Event.findByIdAndUpdate(dbId, { status: 'FAILED' });
            return; // Stop here.
        }

        // Rule B: Max Retries (DLQ Logic)
        if (currentAttempt >= 5) {
            console.log(`💀 DLQ: Job ${job.id} has failed 5 times. Killing it.`);
            
            // 1. Update MongoDB (So your Dashboard turns Red)
            if (dbId) {
                await Event.findByIdAndUpdate(dbId, { 
                    status: 'FAILED', 
                    $push: { logs: { 
                        attempt: currentAttempt, 
                        status: 'DLQ', 
                        response: 'Max retries reached. Job moved to Failed set.' 
                    }}
                });
            }

            // 2. Throw Error (So Redis moves it to "Failed" list)
            throw new Error(`Final Failure: Job reached max attempts (${currentAttempt}).`);
        }

        // Rule C: Schedule the Retry
        const delay = calculateBackoff(currentAttempt, status);
        
        // --- SAFE DB UPDATE ---
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
        // -----------------------

        // Re-add to Queue
        await webhookQueue.add('webhook-job', {
            ...job.data,
            attemptCount: currentAttempt + 1 
        }, {
            delay: delay,
            jobId: `retry-${Date.now()}-${Math.random().toString(36).substring(7)}` 
        });
        
        console.log(`🔄 ALGORITHM: Retry scheduled in ${delay / 1000}s...`);
        
        // (NO THROW HERE) - Worker finishes "successfully", leaving DB status as "RETRYING"
        return { status: 'RETRYING', dbId: dbId };
    }
}, { connection });

// 4. USE ENV VARIABLE FOR MONGO URI
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db')
    .then(() => console.log('✅ Worker connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));