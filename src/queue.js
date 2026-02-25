// src/queue.js
require('dotenv').config();
const { Queue } = require('bullmq');

// 🛡️ DEDICATED CONNECTION: BullMQ uses blocking commands (BRPOPLPUSH/BLMOVE).
// Sharing the app's Redis instance would deadlock the API's idempotency checks
// and circuit breaker. Pass connection *options* so BullMQ creates its own client.
const connectionOptions = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379
};

const myQueue = new Queue('webhook-queue', { connection: connectionOptions });

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