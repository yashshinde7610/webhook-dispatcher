// src/batchProcessor.js
const chalk = require('chalk');
const Event = require('./models/Event');

// --- OS CONFIGURATION ---
const BATCH_SIZE = 100;       // Flush when buffer holds 100 items
const FLUSH_INTERVAL = 2000;  // Flush every 2 seconds max latency

let writeBuffer = [];
let flushTimer = null;

// The "Disk I/O" Function
async function flushBuffer() {
    if (writeBuffer.length === 0) return;

    // Critical Section: Copy & Clear Buffer atomically (in JS terms)
    const currentBatch = [...writeBuffer];
    writeBuffer = []; 

    try {
        console.log(chalk.blue(`💾 [Buffer] Flushing ${currentBatch.length} records to DB...`));

        // Transform buffer items into MongoDB Bulk Operations
        const ops = currentBatch.map(item => ({
            updateOne: {
                filter: { _id: item.dbId },
                update: {
                    status: item.status,
                    finalHttpStatus: item.httpStatus,
                    $push: { logs: item.logEntry }
                }
            }
        }));

        await Event.bulkWrite(ops);
        console.log(chalk.green(`✅ [Buffer] Batch Write Complete.`));
    } catch (err) {
        console.error(chalk.red('❌ [Buffer] Write Failed:'), err);
    }
}

// Start the OS Timer
flushTimer = setInterval(() => {
    if (writeBuffer.length > 0) flushBuffer();
}, FLUSH_INTERVAL);

// Public API for the Worker
module.exports = {
    addToBatch: (data) => {
        writeBuffer.push(data);
        if (writeBuffer.length >= BATCH_SIZE) {
            flushBuffer();
        }
    },
    shutdownBatchProcessor: async () => {
        console.log(chalk.yellow('⚠️ [Buffer] Shutdown signal received. Final flush...'));
        clearInterval(flushTimer);
        await flushBuffer();
    }
};