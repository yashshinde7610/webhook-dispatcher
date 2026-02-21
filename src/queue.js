// src/queue.js
const { Queue } = require('bullmq');
const connection = require('./redis'); 

const myQueue = new Queue('webhook-queue', { connection });

// 👇 We removed the idempotencyKey parameter completely
async function addToQueue(data) {
    return await myQueue.add('webhook-job', data, {
        attempts: 5, 
        backoff: {
            type: 'exponential',
            delay: 1000 
        },
        // 👇 BullMQ now strictly uses the Mongo ID to track the job. 
        // It trusts that the API already handled deduplication.
        jobId: data.dbId ? data.dbId.toString() : undefined,
        
        removeOnComplete: true,
        removeOnFail: false 
    });
}

module.exports = { addToQueue, myQueue };