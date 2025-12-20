// src/worker.js
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
        const response = await axios.post(job.data.url, job.data.payload);
        console.log(`✅ Success! Sent to ${job.data.url} - Status: ${response.status}`);
    } catch (error) {
        console.error(`Failed to send webhook: ${error.message}`);
        throw error;
    }

}, { connection });

console.log('Worker is running and listening for jobs...');