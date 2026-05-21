// src/persistState.js
//
// Persists a job state transition directly to MongoDB.
// Every state change is an awaited atomic write — if Mongo is down,
// the error propagates to BullMQ which retries the whole job.
//
// We skip the PROCESSING intermediate status — BullMQ already tracks
// in-flight state in Redis, so writing only on final resolution cuts
// per-job Mongo writes from 3-4 down to 1.
//
const Event = require('./models/Event');
const { safeHttpStatus } = require('./utils/workerUtils');

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

module.exports = { persistState };
