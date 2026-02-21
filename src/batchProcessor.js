// src/batchProcessor.js
const Event = require('./models/Event'); 
const chalk = require('chalk');

// --- OS CONFIGURATION ---
const BATCH_SIZE = 100;       // Flush when buffer holds 100 items
const FLUSH_INTERVAL = 2000;  // Flush every 2 seconds max latency

let writeBuffer = [];
let isFlushing = false;
let flushInterval = null;

// --- ⚡ ATOMIC FLUSH LOGIC ---
async function flushBuffer() {
    // 1. Concurrency Lock: Prevent overlapping flushes
    if (isFlushing || writeBuffer.length === 0) return;
    isFlushing = true;

    // 2. Thread-Safe Extraction: Empty the buffer synchronously
    const currentBatch = writeBuffer.splice(0, writeBuffer.length);

    // 3. 🛡️ RESTORED DEFENSIVE GUARD
    currentBatch.forEach(item => {
        // If finalHttpStatus is accidentally a string (ENOTFOUND etc)
        if (typeof item.finalHttpStatus === 'string' && item.finalHttpStatus.trim() !== '') {
            console.warn(`[Buffer] coercing string finalHttpStatus -> errorCode for dbId=${item.dbId}:`, item.finalHttpStatus);
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

        // 4. RESTORED PAYLOAD: Build bulk ops for final status and logs
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

        // ordered: false is crucial. If one doc fails validation, the rest still save.
        await Event.bulkWrite(ops, { ordered: false });
        console.log(`✅ [Buffer] Batch Write Complete.`);

    } catch (err) {
        // 5. 🚨 THE BULLETPROOF ERROR HANDLER
        if (err.name === 'MongoBulkWriteError' && err.writeErrors) {
            // POISON PILL DETECTED: 
            console.error(chalk.red(`⚠️ [Buffer] Dropping ${err.writeErrors.length} malformed documents to prevent infinite loop.`));
        } else {
            // TRANSIENT ERROR DETECTED: 
            console.log(chalk.yellow(`🔄 [Buffer] Network blip. Re-queueing batch of ${currentBatch.length} items.`));
            writeBuffer.unshift(...currentBatch);
        }
    } finally {
        isFlushing = false; // Release the lock
    }
}

// --- 📥 ADD TO BATCH ---
function addToBatch(data) {
    writeBuffer.push(data);
    
    // Force an immediate flush if traffic spikes massively
    if (writeBuffer.length >= BATCH_SIZE) {
        flushBuffer();
    }
}

// --- 🟢 RESTORED AUTO-START TIMER ---
flushInterval = setInterval(() => {
    if (writeBuffer.length > 0) flushBuffer();
}, FLUSH_INTERVAL);

// --- 🛑 GRACEFUL SHUTDOWN (Race-Condition Free) ---
async function shutdownBatchProcessor() {
    console.log(chalk.yellow('⚠️ [Buffer] Shutdown signal received. Final flush...'));
    
    // Stop the interval timer
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
    }

    // Await any currently running flush cycle to finish
    while (isFlushing) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Flush anything that accumulated during the wait
    if (writeBuffer.length > 0) {
        await flushBuffer();
    }
}

module.exports = {
    addToBatch,
    shutdownBatchProcessor
};