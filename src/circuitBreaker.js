// src/circuitBreaker.js
const redis = require('./redis');

// ⚙️ CONFIGURATION
const FAILURE_THRESHOLD = 5;   // 5 failures...
const FAILURE_WINDOW = 60;     // ...in 1 minute...
const BREAK_DURATION = 30;     // ...trips the breaker for 30 seconds.
// (I lowered duration to 30s so you can test it faster!)

/**
 * Check if the circuit is OPEN (Blocked)
 */
async function getCircuitStatus(url) {
    const key = `circuit_status:${url}`;
    const status = await redis.get(key);
    return status === 'OPEN' ? 'OPEN' : 'CLOSED';
}

/**
 * Record a failure. If threshold reached, TRIP the breaker.
 */
async function recordFailure(url) {
    const countKey = `circuit_fails:${url}`;
    const statusKey = `circuit_status:${url}`;

    // 1. Increment failure count
    const count = await redis.incr(countKey);

    // 2. If this is the first failure, extend the window to outlast the break
    // duration so we remember this endpoint was failing recently.
    if (count === 1) {
        await redis.expire(countKey, FAILURE_WINDOW + BREAK_DURATION);
    }

    // 3. Check Threshold
    if (count >= FAILURE_THRESHOLD) {
        console.warn(`🛡️  [CIRCUIT BREAKER] Tripped for: ${url}`);
        // Set "OPEN" state for the cooldown duration
        await redis.set(statusKey, 'OPEN', 'EX', BREAK_DURATION);
        // 🛡️ HALF-OPEN FIX: Set counter to threshold-1 instead of deleting.
        // When the breaker expires, the very NEXT failure will instantly
        // trip it again (proper half-open behavior) instead of allowing
        // 5 more requests to bombard the downed server.
        await redis.set(countKey, FAILURE_THRESHOLD - 1);
        await redis.expire(countKey, FAILURE_WINDOW);
    }
}

/**
 * Success resets the failure count (Half-Open -> Closed)
 */
async function recordSuccess(url) {
    await redis.del(`circuit_fails:${url}`);
    // Note: We don't delete 'circuit_status' immediately if it was Half-Open;
    // we just let it expire or manually clear it. For simplicity, we clear fails.
}

module.exports = { getCircuitStatus, recordFailure, recordSuccess };