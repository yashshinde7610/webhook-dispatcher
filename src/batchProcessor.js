// src/batchProcessor.js
const chalk = require('chalk');
const Event = require('./models/Event');
const { safeHttpStatus } = require('./utils/workerUtils');

// --- OS CONFIGURATION ---
const BATCH_SIZE = 100;       // Flush when buffer holds 100 items
const FLUSH_INTERVAL = 2000;  // Flush every 2 seconds max latency

let writeBuffer = [];
let flushTimer = null;

// The "Disk I/O" Function
async function flushBuffer() {
    if (writeBuffer.length === 0) return;

    // 1️⃣ Copy & clear buffer
    const currentBatch = [...writeBuffer];
    writeBuffer = [];

    // 2️⃣ DEFENSIVE GUARD (PUT IT HERE)
    currentBatch.forEach(item => {
        // If finalHttpStatus is accidentally a string (ENOTFOUND etc)
        if (typeof item.finalHttpStatus === 'string' && item.finalHttpStatus.trim() !== '') {
            console.warn(
                `[Buffer] coercing string finalHttpStatus -> errorCode for dbId=${item.dbId}:`,
                item.finalHttpStatus
            );
            item.errorCode = item.errorCode || String(item.finalHttpStatus);
            item.finalHttpStatus = null;
        }

        // If worker accidentally sent httpStatus instead
        if (typeof item.httpStatus === 'string' && item.httpStatus.trim() !== '') {
            const n = Number(item.httpStatus);
            if (Number.isFinite(n)) {
                item.finalHttpStatus = n;
            } else {
                item.errorCode = item.errorCode || String(item.httpStatus);
                item.finalHttpStatus = null;
            }
            delete item.httpStatus;
        }
    });

    try {
        console.log(`💾 [Buffer] Flushing ${currentBatch.length} records to DB...`);

        // 3️⃣ Build bulk ops
        const ops = currentBatch.map(item => ({
            updateOne: {
                filter: { _id: item.dbId },
                update: {
                    $set: {
                        status: item.status,
                        finalHttpStatus: item.finalHttpStatus,
                        failureType: item.failureType || null,
                        lastError: item.lastError || null,
                        errorCode: item.errorCode || null
                    },
                    ...(item.logEntry ? { $push: { logs: item.logEntry } } : {})
                }
            }
        }));

        await Event.bulkWrite(ops);
        console.log(`✅ [Buffer] Batch Write Complete.`);
    } catch (err) {
        console.error('❌ [Buffer] Write Failed:', err);
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