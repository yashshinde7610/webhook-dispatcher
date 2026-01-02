// tests/circuitBreaker.test.js
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// --- 🎭 MOCKING REDIS (The "Jest" Alternative) ---
// We create a fake Redis object to track calls without connecting to DB
const mockRedis = {
    // Internal storage for our mock
    _data: {},
    _calls: [],

    async get(key) { return this._data[key] || null; },
    
    async incr(key) {
        const val = (this._data[key] || 0) + 1;
        this._data[key] = val;
        return val;
    },
    
    async expire(key, ttl) { return true; },
    
    async set(key, val, opt, ttl) { 
        this._data[key] = val;
        this._calls.push({ method: 'set', args: [key, val, opt, ttl] });
        return 'OK';
    },
    
    async del(key) { delete this._data[key]; },

    // Helper to reset state between tests
    _reset() { this._data = {}; this._calls = []; }
};

// 💉 INJECT THE MOCK
// We force Node to use 'mockRedis' whenever './redis' is required
const redisPath = require.resolve('../src/redis');
require.cache[redisPath] = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: mockRedis
};

// 📦 NOW import the file we want to test (It will use the mock above!)
const { recordFailure, getCircuitStatus } = require('../src/circuitBreaker');

// --- 🧪 THE TESTS ---
describe('Circuit Breaker Logic', () => {

    beforeEach(() => {
        mockRedis._reset();
    });

    // ✅ Test 3: Tripping the Breaker
    test('Test 3 (Tripping): Should trip to OPEN after 5 failures', async () => {
        const url = 'http://unstable-api.com';
        
        // 1. Simulate 5 consecutive failures
        for (let i = 1; i <= 5; i++) {
            await recordFailure(url);
        }

        // 2. Check if Redis has the 'OPEN' status set
        const status = await getCircuitStatus(url);
        assert.strictEqual(status, 'OPEN', 'Circuit should be OPEN after 5 failures');

        // 3. Verify the underlying Redis 'set' call arguments
        // We expect: set(key, 'OPEN', 'EX', 30)
        const setCall = mockRedis._calls.find(c => c.method === 'set' && c.args[1] === 'OPEN');
        
        assert.ok(setCall, 'redis.set should have been called with OPEN');
        assert.strictEqual(setCall.args[3], 30, 'Break duration should be 30 seconds');
        
        console.log('   ✅ Circuit correctly tripped after 5 failures.');
    });

});