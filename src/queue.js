// src/queue.js
const { Queue } = require('bullmq');

// BullMQ uses blocking commands (BLMOVE), so it needs its own connection
// to avoid deadlocking the app's regular Redis operations.
const connectionOptions = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379
};

const myQueue = new Queue('webhook-queue', { connection: connectionOptions });

async function addToQueue(data) {
    return await myQueue.add('webhook-job', data, {
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 1000
        },
        // Use the Mongo _id as the BullMQ job ID.
        // Deduplication is already handled at the API layer.
        jobId: data.dbId ? data.dbId.toString() : undefined,
        // Keep last 200 completed jobs in Redis instead of immediate deletion.
        // This narrows the data-loss window: if the process crashes between
        // persistState (Mongo write) and BullMQ's completion ack, the job
        // is still recoverable from Redis for inspection.
        removeOnComplete: { count: 200 },
        removeOnFail: false
    });
}

module.exports = { addToQueue, myQueue };