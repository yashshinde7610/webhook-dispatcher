// src/queue.js
const { Queue } = require('bullmq');

const connection = {
    host: '127.0.0.1',
    port: 6379
};

const myQueue = new Queue('webhook-queue', { connection });

async function addToQueue(data) {
    // We add the job to Redis
    return await myQueue.add('webhook-job', data, {
        // 1. SYNC ID: Force Redis to use the MongoDB ID (Fixes Dashboard Bug)
        jobId: data.dbId ? data.dbId.toString() : undefined,
        
        // 2. RETRY LOGIC (Day 4 Feature)
        attempts: 5,               // Retry 5 times on failure
        backoff: {
            type: 'exponential',   // Wait 2s, 4s, 8s...
            delay: 1000
        },

        // 3. CLEANUP
        removeOnComplete: true,    // Remove successful jobs to save RAM
        removeOnFail: false        // Keep failed jobs so we can Replay them
    });
}

module.exports = { addToQueue, myQueue };