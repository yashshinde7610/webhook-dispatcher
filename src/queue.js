// src/queue.js
const { Queue } = require('bullmq');

const connection = { host: '127.0.0.1', port: 6379 };
const myQueue = new Queue('webhook-queue', { connection });

async function addToQueue(data) {
    return await myQueue.add('webhook-job', data, {
        // 1. SYNC ID: Keep the DB ID sync so Dashboard works
        jobId: data.dbId ? data.dbId.toString() : undefined,
        
        // 2. DISABLE AUTO-RETRY: We set this to 1 because we are writing
        //    our own custom retry algorithm in the worker.
        attempts: 1, 
        
        removeOnComplete: true,
        removeOnFail: false
    });
}

module.exports = { addToQueue, myQueue };