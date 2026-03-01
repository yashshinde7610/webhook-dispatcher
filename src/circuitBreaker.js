// src/circuitBreaker.js
const redis = require('./redis');

/**
 * Extract the hostname from a URL so the circuit breaker keys by host,
 * not by the full path.  Without this, millions of unique paths
 * (e.g. example.com/user/1 … /user/N) each get their own counter and
 * the breaker never trips for the failing *server*.
 */
function extractHost(url) {
    try { return new URL(url).hostname; } catch { return url; }
}

// ⚙️ CONFIGURATION
const FAILURE_THRESHOLD = 5;   // 5 failures...
const FAILURE_WINDOW = 60;     // ...in 1 minute...
const BREAK_DURATION = 30;     // ...trips the breaker for 30 seconds.

// --- 🛡️ HALF-OPEN STATE MACHINE ---
//
// PROBLEM (old approach):
//   Setting the counter to THRESHOLD-1 when the breaker trips means ALL 50
//   concurrent workers will bypass the check simultaneously after the break
//   expires, bombarding the recovering server with up to 50 requests.
//
// THE FIX:
//   Use three Redis keys per host:
//     circuit_status:{host}  — "OPEN" during break  (TTL = BREAK_DURATION)
//     circuit_fails:{host}   — failure counter       (TTL = FAILURE_WINDOW)
//     circuit_probe:{host}   — half-open probe lock  (TTL = 10s, SET NX)
//
//   When the break expires (circuit_status key gone), `getCircuitStatus`
//   checks the failure counter.  If it is still >= THRESHOLD-1, the circuit
//   enters HALF_OPEN.  In HALF_OPEN, a single probe request is allowed
//   through by acquiring `circuit_probe:{host}` with NX.  All other workers
//   fast-fail.  If the probe succeeds → CLOSED.  If it fails → re-OPEN.

/**
 * Check the circuit state for a URL.
 * Returns: 'OPEN' | 'HALF_OPEN_BLOCKED' | 'HALF_OPEN_PROBE' | 'CLOSED'
 *
 * Worker behaviour:
 *   OPEN              → throw immediately
 *   HALF_OPEN_BLOCKED → throw immediately (a probe is already in flight)
 *   HALF_OPEN_PROBE   → this worker won the probe lock; send the request
 *   CLOSED            → send the request normally
 */
async function getCircuitStatus(url) {
    const host = extractHost(url);
    const statusKey = `circuit_status:${host}`;
    const countKey  = `circuit_fails:${host}`;
    const probeKey  = `circuit_probe:${host}`;

    // 1. If the breaker is explicitly OPEN, fast-fail.
    const status = await redis.get(statusKey);
    if (status === 'OPEN') return 'OPEN';

    // 2. Breaker not OPEN — check if we're in the half-open window.
    //    If the failure count is still at threshold-1 (set when we tripped),
    //    only one probe request should go through.
    const count = await redis.get(countKey);
    if (count !== null && Number(count) >= FAILURE_THRESHOLD - 1) {
        // Try to acquire the probe lock (NX = only if it doesn't exist)
        const acquired = await redis.set(probeKey, '1', 'EX', 10, 'NX');
        if (acquired) {
            return 'HALF_OPEN_PROBE';  // This worker sends the probe
        }
        return 'HALF_OPEN_BLOCKED';    // Another probe is already in flight
    }

    return 'CLOSED';
}

/**
 * Record a failure. If threshold reached, TRIP the breaker.
 */
async function recordFailure(url) {
    const host = extractHost(url);
    const countKey  = `circuit_fails:${host}`;
    const statusKey = `circuit_status:${host}`;

    // 1. Increment failure count
    const count = await redis.incr(countKey);

    // 2. If this is the first failure, set the window TTL
    if (count === 1) {
        await redis.expire(countKey, FAILURE_WINDOW + BREAK_DURATION);
    }

    // 3. Check Threshold
    if (count >= FAILURE_THRESHOLD) {
        console.warn(`🛡️  [CIRCUIT BREAKER] Tripped for: ${url}`);
        // Set "OPEN" state for the cooldown duration
        await redis.set(statusKey, 'OPEN', 'EX', BREAK_DURATION);
        // Set counter to threshold-1 so the half-open logic kicks in
        // once the OPEN key expires.
        await redis.set(countKey, String(FAILURE_THRESHOLD - 1));
        await redis.expire(countKey, FAILURE_WINDOW + BREAK_DURATION);
    }
}

/**
 * Record a success.  Clears the failure counter AND the probe lock,
 * fully closing the circuit (HALF_OPEN → CLOSED transition).
 */
async function recordSuccess(url) {
    const host = extractHost(url);
    await redis.del(`circuit_fails:${host}`);
    await redis.del(`circuit_probe:${host}`);
}

module.exports = { getCircuitStatus, recordFailure, recordSuccess };