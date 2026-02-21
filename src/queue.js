// src/queue.js
const { Queue } = require('bullmq');
const connection = require('./redis'); // <--- Use your shared Redis connection

const myQueue = new Queue('webhook-queue', { connection });
async function addToQueue(data, idempotencyKey = null) {
    return await myQueue.add('webhook-job', data, {
        attempts: 5, 
        backoff: {
            type: 'exponential',
            delay: 1000 
        },
        // 👇 CRITICAL FIX: Use idempotencyKey if provided, fallback to dbId
        // BullMQ will completely ignore new jobs if a job with this ID already exists!
        jobId: idempotencyKey || (data.dbId ? data.dbId.toString() : undefined),
        
        removeOnComplete: true,
        removeOnFail: false 
    });
}

module.exports = { addToQueue, myQueue };