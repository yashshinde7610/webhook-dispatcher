// src/worker.js
const crypto = require('crypto');
const { Worker } = require('bullmq');
const axios = require('axios');

const connection = {
    host: '127.0.0.1',
    port: 6379
};

// --- CHAOS MONKEY ---
// Returns true 50% of the time (Simulates a crash)
function shouldFail() {
    return false;
}

const worker = new Worker('webhook-queue', async (job) => {
    console.log(`Processing Job ${job.id}...`);

    // 1. Simulate Random Failure
    if (shouldFail()) {
        const error = new Error('CHAOS MONKEY STRUCK! 🐒');
        console.error(`❌ ${error.message} (Job ${job.id} will retry)`);
        throw error; // This triggers the retry logic
    }

    // 2. Real Logic
    try {
       // --- NEW SECURITY LOGIC ---
// 1. Create the signature
        const signature = createHmacSignature(job.data.payload);

// 2. Send request WITH the signature header
        const response = await axios.post(job.data.url, job.data.payload, {
            headers: {
                'X-Signature': signature, // <--- The proof it came from us
                'Content-Type': 'application/json'
    }
});
console.log(`✅ Success! Sent to ${job.data.url} - Status: ${response.status}`);
    } catch (error) {
        console.error(`Failed to send webhook: ${error.message}`);
        throw error;
    }

}, { connection });

console.log('Worker is running and listening for jobs...');
function createHmacSignature(payload) {
    // In a real app, this secret would be in .env
    const secret = 'my_super_secret_webhook_key'; 
    return crypto.createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');
}