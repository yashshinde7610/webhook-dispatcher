// src/services/lockService.js
/**
 * Attempts to acquire a distributed lock for idempotency.
 * @param {Object} redis - The Redis client instance
 * @param {String} dbId - The unique ID of the job/event
 * @param {Number} ttlSeconds - Time to live for the lock
 * @returns {Promise<boolean>} - True if lock acquired, False if already locked
 */
async function acquireIdempotencyLock(redis, dbId, ttlSeconds = 86400) {
    const key = `idempotency:${dbId}`;
    // 'NX' = Only set if Not Exists
    const result = await redis.set(key, 'LOCKED', 'NX', 'EX', ttlSeconds);
    return result === 'OK';
}

async function releaseIdempotencyLock(redis, dbId) {
    const key = `idempotency:${dbId}`;
    await redis.del(key);
}

module.exports = { acquireIdempotencyLock, releaseIdempotencyLock };