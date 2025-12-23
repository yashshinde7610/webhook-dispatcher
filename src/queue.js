// src/queue.js
const { Queue } = require('bullmq');
const connection = require('./redis'); // <--- Use your shared Redis connection

const myQueue = new Queue('webhook-queue', { connection });

async function addToQueue(data) {
    return await myQueue.add('webhook-job', data, {
        // --- ⚡ IMPORTANT CHANGES ---
        
        // 1. Enable Retries
        // We now rely on BullMQ to handle the "Try again later" logic
        attempts: 5, 
        
        // 2. Exponential Backoff
        // If it fails, wait 1s, then 2s, then 4s, etc.
        backoff: {
            type: 'exponential',
            delay: 1000 
        },

        // 3. Keep the DB ID as the Job ID
        // This links the Redis job directly to your Mongo record
        jobId: data.dbId ? data.dbId.toString() : undefined,
        
        removeOnComplete: true,
        removeOnFail: false 
    });
}

module.exports = { addToQueue, myQueue };