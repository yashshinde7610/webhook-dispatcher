// src/batchProcessor.js
//
// ARCHITECTURE NOTE — WHY THE IN-MEMORY BUFFER WAS REMOVED
// =========================================================
// The previous implementation buffered MongoDB writes in a volatile Node.js
// array (`writeBuffer`), flushing periodically via setInterval, with a custom
// Redis DLQ for overflow.  This caused three critical problems:
//
//   1. DATA LOSS ON CRASH — SIGKILL, OOM, or segfault instantly vaporizes
//      everything in the buffer.  The "graceful shutdown" trap cannot help.
//
//   2. SPLIT-BRAIN AT SCALE — Multiple worker instances would blindly drain
//      `webhook:mongo_overflow_dlq` without distributed locking, causing
//      duplicated and out-of-order MongoDB writes.
//
//   3. REDUNDANT COMPLEXITY — BullMQ already stores durable job state in
//      Redis and retries with exponential backoff.  A second buffering layer
//      adds risk for zero benefit.
//
// THE FIX:
//   Every state transition is now a direct, atomic, **awaited** MongoDB write.
//   If MongoDB is temporarily unreachable the write throws, the error
//   propagates up to the BullMQ worker processor, and BullMQ retries the
//   entire job with exponential backoff — exactly the durability guarantee
//   we need, with zero custom code.
//
const Event = require('./models/Event');
const { safeHttpStatus } = require('./utils/workerUtils');

/**
 * Persist a job state transition directly to MongoDB (atomic write).
 *
 * Replaces the old fire-and-forget `addToBatch()`.  Every call is awaited,
 * so failures bubble up to BullMQ which retries the job automatically.
 *
 * @param {Object} data
 * @param {string}  data.dbId           - Mongoose ObjectId for the Event document
 * @param {string}  data.status         - Target status (PROCESSING, COMPLETED, …)
 * @param {boolean} [data.upsert]       - Create the document if it doesn't exist
 * @param {Object}  [data.initialData]  - Fields for $setOnInsert (first write)
 * @param {Object}  [data.logEntry]     - Entry to $push into `logs`
 * @param {string}  [data.failureType]  - TRANSIENT | PERMANENT
 * @param {string}  [data.lastError]    - Human-readable error message
 * @param {*}       [data.httpStatus]   - Raw HTTP status (sanitized here)
 * @param {string}  [data.errorCode]    - e.g. ECONNREFUSED
 */
async function persistState(data) {
    if (!data.dbId) return;

    // --- Sanitize httpStatus (ported from the old buffer's defensive guards) ---
    let finalHttpStatus = data.finalHttpStatus ?? null;
    let errorCode = data.errorCode || null;

    if (data.httpStatus !== undefined) {
        const sanitized = safeHttpStatus(data.httpStatus);
        if (sanitized !== null) {
            finalHttpStatus = sanitized;
        } else if (typeof data.httpStatus === 'string' && data.httpStatus.trim() !== '') {
            errorCode = errorCode || String(data.httpStatus);
        }
    }

    // --- Build the atomic update ---
    const update = {
        $set: {
            status: data.status,
            finalHttpStatus,
            failureType: data.failureType || null,
            lastError: data.lastError || null,
            errorCode,
        },
    };

    if (data.logEntry) {
        // 🛡️ BOUNDED ARRAY: $slice keeps only the N most recent log entries,
        // preventing unbounded document growth toward MongoDB's 16 MB limit.
        // The cap is co-located with the schema (Event.MAX_LOGS).
        update.$push = {
            logs: {
                $each: [data.logEntry],
                $slice: -(Event.MAX_LOGS || 20)   // negative = keep last N
            }
        };
    }

    const options = {};

    // Upsert on first touch — $setOnInsert writes immutable fields only once.
    if (data.upsert && data.initialData) {
        options.upsert = true;
        update.$setOnInsert = data.initialData;
    }

    // Increment attempt count for actual delivery attempts
    if (data.incrementAttempt || (data.upsert && data.initialData)) {
        update.$inc = { ...(update.$inc || {}), attemptCount: 1 };
    }

    await Event.updateOne({ _id: data.dbId }, update, options);
}

module.exports = {
    persistState,
    // Backward-compatible aliases so callers migrate incrementally
    addToBatch: persistState,
    shutdownBatchProcessor: async () => { /* no-op — nothing to flush */ },
};