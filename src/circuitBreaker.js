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

// --- 🛡️ ATOMIC FAILURE RECORDING (Lua Script) ---
//
// PROBLEM (old approach):
//   Sequential Redis calls (INCR → check → SET OPEN) are a classic
//   "Check-Then-Act" race condition.  If 100 workers fail at the same
//   millisecond, they all INCR, all see count >= threshold, and all
//   independently fire SET OPEN.  Wasted network calls and potential
//   inconsistency if EXPIRE or SET fails mid-sequence.
//
// THE FIX:
//   A Lua script runs atomically inside Redis (single-threaded).
//   The increment, threshold check, and state transition are ONE operation
//   — impossible to interleave.
redis.defineCommand('tripCircuit', {
    numberOfKeys: 2,
    lua: `
        local countKey     = KEYS[1]
        local statusKey    = KEYS[2]
        local threshold    = tonumber(ARGV[1])
        local window       = tonumber(ARGV[2])
        local breakDuration = tonumber(ARGV[3])

        local count = redis.call('INCR', countKey)
        if count == 1 then
            redis.call('EXPIRE', countKey, window + breakDuration)
        end
        if count >= threshold then
            redis.call('SET', statusKey, 'OPEN', 'EX', breakDuration)
            -- Reset counter to threshold-1 so the half-open probe logic
            -- kicks in once the OPEN key expires.
            redis.call('SET', countKey, tostring(threshold - 1))
            redis.call('EXPIRE', countKey, window)
            return 'TRIPPED'
        end
        return 'OK'
    `
});

// --- 🛡️ HALF-OPEN STATE MACHINE ---
//
//   Three Redis keys per host:
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
 * Record a failure.  The Lua script atomically increments the counter,
 * checks the threshold, and trips the breaker — all in one Redis round-trip.
 */
async function recordFailure(url) {
    const host = extractHost(url);
    const countKey  = `circuit_fails:${host}`;
    const statusKey = `circuit_status:${host}`;

    const result = await redis.tripCircuit(
        countKey, statusKey,
        FAILURE_THRESHOLD, FAILURE_WINDOW, BREAK_DURATION
    );

    if (result === 'TRIPPED') {
        console.warn(`🛡️  [CIRCUIT BREAKER] Tripped for: ${url}`);
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