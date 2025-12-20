const { Queue } = require('bullmq');

// 1. Create a connection to Redis
const connection = {
    host: '127.0.0.1', 
    port: 6379
};

// 2. Initialize the Queue
const myQueue = new Queue('webhook-queue', { connection });

// 3. Create a helper function to add jobs
// UPGRADE: Added retry logic (attempts & backoff)
async function addToQueue(data) {
    await myQueue.add('webhook-job', data, {
        attempts: 5,               // Retry 5 times if it fails
        backoff: {
            type: 'exponential',   // Wait 1s, 2s, 4s... between tries
            delay: 1000 
        }
    });
    console.log('Job added to Redis queue with retry logic:', data);
}

module.exports = { addToQueue };