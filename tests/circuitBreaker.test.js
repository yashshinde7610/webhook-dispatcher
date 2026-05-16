// tests/circuitBreaker.test.js
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// Mock Redis — we implement the Lua tripCircuit logic in JS since
// we can't run Lua outside of Redis
const mockRedis = {
    _data: {},
    _calls: [],

    async get(key) { return this._data[key] !== undefined ? this._data[key] : null; },

    async incr(key) {
        const val = (this._data[key] || 0) + 1;
        this._data[key] = val;
        return val;
    },

    async expire(key, ttl) { return true; },

    async set(key, val, ...rest) {
        const hasNX = rest.includes('NX');
        if (hasNX && this._data[key] !== undefined) {
            this._calls.push({ method: 'set', args: [key, val, ...rest], result: null });
            return null;
        }
        this._data[key] = val;
        this._calls.push({ method: 'set', args: [key, val, ...rest], result: 'OK' });
        return 'OK';
    },

    async del(key) { delete this._data[key]; },

    // Simulate redis.defineCommand — replicates the Lua logic in JS
    defineCommand(name, _config) {
        if (name === 'tripCircuit') {
            this.tripCircuit = async (countKey, statusKey, threshold, window, breakDuration) => {
                threshold = Number(threshold);
                window = Number(window);
                breakDuration = Number(breakDuration);

                const count = await this.incr(countKey);
                if (count === 1) await this.expire(countKey, window + breakDuration);
                if (count >= threshold) {
                    await this.set(statusKey, 'OPEN', 'EX', breakDuration);
                    this._data[countKey] = threshold - 1;
                    await this.expire(countKey, window);
                    return 'TRIPPED';
                }
                return 'OK';
            };
        }
    },

    _reset() { this._data = {}; this._calls = []; }
};

// Inject mock before importing the module under test
const redisPath = require.resolve('../src/redis');
require.cache[redisPath] = {
    id: redisPath, filename: redisPath, loaded: true, exports: mockRedis
};

const { recordFailure, getCircuitStatus } = require('../src/circuitBreaker');

describe('Circuit Breaker', () => {
    beforeEach(() => mockRedis._reset());

    test('should trip to OPEN after 5 consecutive failures', async () => {
        const url = 'http://unstable-api.com';

        for (let i = 0; i < 5; i++) {
            await recordFailure(url);
        }

        const status = await getCircuitStatus(url);
        assert.strictEqual(status, 'OPEN');

        // Verify the OPEN key was set with the correct TTL (30s)
        const setCall = mockRedis._calls.find(c => c.method === 'set' && c.args[1] === 'OPEN');
        assert.ok(setCall, 'OPEN status should be set in Redis');
        const exIdx = setCall.args.indexOf('EX');
        assert.strictEqual(setCall.args[exIdx + 1], 30, 'Break duration should be 30s');
    });

    test('should return CLOSED when no failures recorded', async () => {
        const status = await getCircuitStatus('http://healthy-api.com');
        assert.strictEqual(status, 'CLOSED');
    });

    test('should allow a half-open probe after break expires', async () => {
        const url = 'http://recovering-api.com';

        // Trip the breaker
        for (let i = 0; i < 5; i++) await recordFailure(url);
        assert.strictEqual(await getCircuitStatus(url), 'OPEN');

        // Simulate break expiry by removing the OPEN status key
        // (in real Redis this happens via TTL)
        const host = new URL(url).hostname;
        delete mockRedis._data[`circuit_status:${host}`];

        // First request should get HALF_OPEN_PROBE (wins the lock)
        const status = await getCircuitStatus(url);
        assert.strictEqual(status, 'HALF_OPEN_PROBE');

        // Second request should be blocked (probe already in flight)
        const status2 = await getCircuitStatus(url);
        assert.strictEqual(status2, 'HALF_OPEN_BLOCKED');
    });
});