// src/batchProcessor.js
const Event = require('./models/Event'); 
const redis = require('./redis'); // 👈 ADDED: Import Redis for durable fallback
const chalk = require('chalk');

// --- OS CONFIGURATION ---
const BATCH_SIZE = 100;       
const FLUSH_INTERVAL = 2000;  
const MAX_BUFFER_SIZE = 5000; // 🚨 OOM PROTECTION: Max items allowed in RAM
const REDIS_DLQ_KEY = 'webhook:mongo_overflow_dlq';

let writeBuffer = [];
let isFlushing = false;
let flushInterval = null;

// --- ⚡ ATOMIC FLUSH LOGIC ---
async function flushBuffer() {
    // 1. Concurrency Lock
    if (isFlushing) return;
    isFlushing = true;

    // 🟢 2. SELF-HEALING RECOVERY: Drain Redis DLQ if DB is up & memory is clear
    if (writeBuffer.length < BATCH_SIZE) {
        try {
            const dlqSize = await redis.llen(REDIS_DLQ_KEY);
            if (dlqSize > 0) {
                const toRecover = Math.min(dlqSize, BATCH_SIZE);
                const pipeline = redis.pipeline();
                
                // RPOP pulls oldest items first (FIFO)
                for (let i = 0; i < toRecover; i++) {
                    pipeline.rpop(REDIS_DLQ_KEY);
                }
                
                const results = await pipeline.exec();
                const recoveredItems = [];
                
                results.forEach(res => {
                    if (res[1]) {
                        try {
                            recoveredItems.push(JSON.parse(res[1]));
                        } catch (parseErr) {
                            console.error(chalk.red('⚠️ [Buffer] Corrupted JSON in Redis DLQ'), parseErr);
                        }
                    }
                });

                if (recoveredItems.length > 0) {
                    console.log(chalk.cyan(`♻️ [Buffer] Recovered ${recoveredItems.length} items from Redis DLQ.`));
                    writeBuffer.unshift(...recoveredItems);
                }
            }
        } catch (dlqErr) {
            console.error(chalk.red(`⚠️ [Buffer] Failed to read from Redis DLQ:`), dlqErr.message);
        }
    }

    // Exit early if nothing to write
    if (writeBuffer.length === 0) {
        isFlushing = false;
        return;
    }

    // 3. Thread-Safe Extraction
    const currentBatch = writeBuffer.splice(0, writeBuffer.length);

    // 4. Defensive Guards
    currentBatch.forEach(item => {
        if (typeof item.finalHttpStatus === 'string' && item.finalHttpStatus.trim() !== '') {
            item.errorCode = item.errorCode || String(item.finalHttpStatus);
            item.finalHttpStatus = null;
        }
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
        // 5. Build bulk ops & execute
        // ALL state transitions flow through this single ordered pipe.
        // Because the writeBuffer is FIFO, PROCESSING is always written
        // before COMPLETED/FAILED—no sync/async race condition possible.
        const ops = currentBatch.map(item => {
            const op = {
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
            };

            // 🏗️ UPSERT SUPPORT: If the document doesn't exist yet (1st attempt),
            // $setOnInsert creates it with the initial immutable fields.
            if (item.upsert && item.initialData) {
                op.updateOne.upsert = true;
                op.updateOne.update.$setOnInsert = item.initialData;
                op.updateOne.update.$inc = { attemptCount: 1 };
            }

            return op;
        });

        await Event.bulkWrite(ops, { ordered: false });
        console.log(`✅ [Buffer] Batch Write Complete (${currentBatch.length} records).`);

    } catch (err) {
        if (err.name === 'MongoBulkWriteError' && err.writeErrors) {
            console.error(chalk.red(`⚠️ [Buffer] Dropping ${err.writeErrors.length} malformed documents to prevent loop.`));
        } else {
            console.log(chalk.yellow(`🔄 [Buffer] Network blip. Handling ${currentBatch.length} items.`));
            
            // 🚨 THE FIX: OOM TIMEBOMB PROTECTION
            if (writeBuffer.length + currentBatch.length > MAX_BUFFER_SIZE) {
                console.error(chalk.red.bold(`🚨 [Buffer] OOM PROTECTION TRIGGERED: Buffer full! Overflowing to Redis DLQ!`));
                try {
                    const serializedBatch = currentBatch.map(item => JSON.stringify(item));
                    // LPUSH adds to the top of the list, keeping our FIFO flow intact
                    await redis.lpush(REDIS_DLQ_KEY, ...serializedBatch);
                    console.log(chalk.yellow(`📦 [Buffer] Saved ${currentBatch.length} items to Redis DLQ safely.`));
                } catch (redisErr) {
                    console.error(chalk.bgRed.white(`💀 [Buffer] FATAL: Redis is down too! Force keeping in memory.`), redisErr.message);
                    // Catastrophic failure: Both Mongo and Redis down. Retain in memory as a desperate last resort.
                    writeBuffer.unshift(...currentBatch);
                }
            } else {
                // Safe to keep in RAM
                writeBuffer.unshift(...currentBatch);
            }
        }
    } finally {
        isFlushing = false; 
    }
}

// --- 📥 ADD TO BATCH (With Backpressure) ---
async function addToBatch(data) {
    // 🚨 BACKPRESSURE: If buffer is at capacity, divert directly to Redis DLQ
    if (writeBuffer.length >= MAX_BUFFER_SIZE) {
        try {
            await redis.lpush(REDIS_DLQ_KEY, JSON.stringify(data));
            console.log(chalk.yellow(`🚨 [Buffer] Backpressure: Diverted 1 item to Redis DLQ (buffer at ${MAX_BUFFER_SIZE} cap).`));
        } catch (redisErr) {
            console.error(chalk.bgRed.white(`💀 [Buffer] FATAL: Cannot divert to Redis DLQ!`), redisErr.message);
            // Last resort: push to buffer anyway (prefer potential OOM over silent data drop)
            writeBuffer.push(data);
        }
        return;
    }
    writeBuffer.push(data);
    if (writeBuffer.length >= BATCH_SIZE) flushBuffer();
}

// --- 🟢 AUTO-START TIMER ---
flushInterval = setInterval(() => {
    if (writeBuffer.length > 0) flushBuffer();
}, FLUSH_INTERVAL);

// --- 🛑 GRACEFUL SHUTDOWN ---
async function shutdownBatchProcessor() {
    console.log(chalk.yellow('⚠️ [Buffer] Shutdown signal received. Final flush...'));
    
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
    }

    while (isFlushing) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (writeBuffer.length > 0) {
        await flushBuffer();
    }

    // 🛡️ SAFETY NET: If items remain after flush (Mongo was down), dump to Redis DLQ
    // This prevents permanent data loss on shutdown during a database outage.
    if (writeBuffer.length > 0) {
        console.log(chalk.yellow(`⚠️ [Buffer] ${writeBuffer.length} items remain after flush. Dumping to Redis DLQ for recovery...`));
        try {
            const serialized = writeBuffer.map(item => JSON.stringify(item));
            await redis.lpush(REDIS_DLQ_KEY, ...serialized);
            console.log(chalk.green(`✅ [Buffer] Safely persisted ${writeBuffer.length} items to Redis DLQ.`));
            writeBuffer = [];
        } catch (redisErr) {
            console.error(chalk.bgRed.white(`💀 [Buffer] FATAL: Could not persist to Redis! ${writeBuffer.length} items at risk.`), redisErr.message);
            // Last resort: dump to disk
            try {
                const fs = require('fs');
                const path = require('path');
                const dumpPath = path.join(__dirname, '..', `buffer_dump_${Date.now()}.json`);
                fs.writeFileSync(dumpPath, JSON.stringify(writeBuffer, null, 2));
                console.log(chalk.yellow(`📁 [Buffer] Emergency disk dump: ${dumpPath}`));
                writeBuffer = [];
            } catch (diskErr) {
                console.error(chalk.bgRed.white(`💀 [Buffer] CATASTROPHIC: Disk dump also failed! Data lost.`), diskErr.message);
            }
        }
    }
}

module.exports = {
    addToBatch,
    shutdownBatchProcessor
};