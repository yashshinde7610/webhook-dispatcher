// src/batchProcessor.js
//
// Direct MongoDB writes for job state transitions.
//
// We used to buffer writes in memory and flush periodically, but that
// caused data loss on crash and split-brain issues with multiple workers.
// Now every state change is an awaited atomic write — if Mongo is down,
// the error propagates to BullMQ which retries the whole job.
//
const Event = require('./models/Event');
const { safeHttpStatus } = require('./utils/workerUtils');

/**
 * Persist a job state transition directly to MongoDB.
 * Failures bubble up to BullMQ which handles retries.
 */
async function persistState(data) {
    if (!data.dbId) return;

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
        // $slice keeps only the last N entries to prevent unbounded growth
        update.$push = {
            logs: {
                $each: [data.logEntry],
                $slice: -(Event.MAX_LOGS || 20)
            }
        };
    }

    const options = {};

    if (data.upsert && data.initialData) {
        options.upsert = true;
        update.$setOnInsert = data.initialData;
    }

    if (data.incrementAttempt || (data.upsert && data.initialData)) {
        update.$inc = { ...(update.$inc || {}), attemptCount: 1 };
    }

    await Event.updateOne({ _id: data.dbId }, update, options);
}

module.exports = {
    persistState,
    addToBatch: persistState, // backward compat
    shutdownBatchProcessor: async () => { /* no-op */ },
};