// src/circuitBreaker.js
//
// Distributed circuit breaker backed by Redis. Tracks failures per host
// and trips the breaker if a threshold is exceeded within a time window.
// Uses a Lua script so the increment + threshold check + state transition
// all happen atomically — no race conditions under high concurrency.
//
const redis = require('./redis');
const logger = require('./utils/logger');

function extractHost(url) {
    try { return new URL(url).hostname; } catch { return url; }
}

// Config
const FAILURE_THRESHOLD = 5;   // failures needed to trip
const FAILURE_WINDOW = 60;     // window in seconds
const BREAK_DURATION = 30;     // how long the circuit stays open

// Lua script: atomically increments the failure counter and trips
// the breaker if the threshold is reached. Without this, 100 workers
// failing simultaneously would all race through INCR -> check -> SET.
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
            redis.call('SET', countKey, tostring(threshold - 1))
            redis.call('EXPIRE', countKey, window)
            return 'TRIPPED'
        end
        return 'OK'
    `
});

// State machine:
//   CLOSED           -> normal operation
//   OPEN             -> all requests fast-fail
//   HALF_OPEN_PROBE  -> one worker gets to send a test request
//   HALF_OPEN_BLOCKED -> probe already in flight, everyone else waits
async function getCircuitStatus(url) {
    const host = extractHost(url);
    const statusKey = `circuit_status:${host}`;
    const countKey  = `circuit_fails:${host}`;
    const probeKey  = `circuit_probe:${host}`;

    const status = await redis.get(statusKey);
    if (status === 'OPEN') return 'OPEN';

    // If failure count is still high after the break expired, we're
    // in half-open territory — let one probe through via NX lock
    const count = await redis.get(countKey);
    if (count !== null && Number(count) >= FAILURE_THRESHOLD - 1) {
        const acquired = await redis.set(probeKey, '1', 'EX', 10, 'NX');
        if (acquired) return 'HALF_OPEN_PROBE';
        return 'HALF_OPEN_BLOCKED';
    }

    return 'CLOSED';
}

async function recordFailure(url) {
    const host = extractHost(url);
    const countKey  = `circuit_fails:${host}`;
    const statusKey = `circuit_status:${host}`;

    const result = await redis.tripCircuit(
        countKey, statusKey,
        FAILURE_THRESHOLD, FAILURE_WINDOW, BREAK_DURATION
    );

    if (result === 'TRIPPED') {
        logger.warn({ url }, 'Circuit breaker tripped');
    }
}

async function recordSuccess(url) {
    const host = extractHost(url);
    await redis.del(`circuit_fails:${host}`);
    await redis.del(`circuit_probe:${host}`);
}

module.exports = { getCircuitStatus, recordFailure, recordSuccess };