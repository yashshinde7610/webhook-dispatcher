// src/worker.js (The "Algorithm" Version)
const { Worker, Queue } = require('bullmq'); // Import Queue to re-add jobs
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const Event = require('./models/Event'); // Adjust path if needed


// Redis Connection
const connection = { host: '127.0.0.1', port: 6379 };

// Create a Queue instance so we can manually re-add jobs
const webhookQueue = new Queue('webhook-queue', { connection });

// Helper: HMAC Signature
function createHmacSignature(payload) {
    const secret = 'my_super_secret_webhook_key';
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

// Helper: Calculate Custom Backoff
function calculateBackoff(attempts, status) {
    if (status === 429) {
        // This log is how you know the algorithm recognized the Rate Limit
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
        // --- CHAOS MONKEY (Optional: Keep it for testing 500s) ---
        // if (Math.random() < 0.5) throw { response: { status: 500 } }; 
        if ((job.data.attemptCount || 1) === 1) {
        throw { response: { status: 429 }, message: "Too Many Requests (demo)" };
}



        // 1. Sign & Send
        const signature = createHmacSignature(job.data.payload);
        const response = await axios.post(job.data.url, job.data.payload, {
            headers: { 'X-Signature': signature, 'Content-Type': 'application/json' }
        });

        console.log(`✅ Success! Status: ${response.status}`);
        
        // 2. Update DB
        if (dbId) {
            await Event.findByIdAndUpdate(dbId, { 
                status: 'COMPLETED',
                $push: { logs: { attempt: currentAttempt, status: response.status, response: 'Success' } }
            });
        }

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

        // Rule B: Max Retries (e.g., 5)
        if (currentAttempt >= 5) {
            console.log('💀 Max retries reached. Moving to DLQ.');
            if (dbId) await Event.findByIdAndUpdate(dbId, { status: 'FAILED' });
            return; // Stop here.
        }

        // Rule C: Schedule the Retry
        const delay = calculateBackoff(currentAttempt, status);
        
        // Re-add to Queue with new delay
        await webhookQueue.add('webhook-job', {
            ...job.data,
            attemptCount: currentAttempt + 1 
        }, {
            delay: delay,
            // FIX: Using a random suffix ensures Redis NEVER blocks this retry
            jobId: `retry-${Date.now()}-${Math.random().toString(36).substring(7)}` 
        });
        
        console.log(`🔄 ALGORITHM: Retry scheduled in ${delay / 1000}s...`);
    }
}, { connection });