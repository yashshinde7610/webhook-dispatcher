// tests/worker.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { classifyError } = require('../src/utils/workerUtils');

describe('Worker Logic Tests (classifyError)', () => {

    // ✅ Test 1: Transient Errors (Network)
    test('Test 1 (Transient Error): Code ECONNREFUSED or ETIMEDOUT should return TRANSIENT', () => {
        const errorRefused = { code: 'ECONNREFUSED' };
        const errorTimeout = { code: 'ETIMEDOUT' };

        assert.strictEqual(classifyError(errorRefused), 'TRANSIENT');
        assert.strictEqual(classifyError(errorTimeout), 'TRANSIENT');
    });

    // ✅ Test 2: Permanent Errors (Bad Request)
    test('Test 2 (Permanent Error): Status 400 should return PERMANENT', () => {
        const errorBadRequest = { response: { status: 400 } };
        
        assert.strictEqual(classifyError(errorBadRequest), 'PERMANENT');
    });

    // ✅ Test 3: Rate Limiting (Too Many Requests)
    test('Test 3 (Rate Limiting): Status 429 should return TRANSIENT', () => {
        const errorRateLimit = { response: { status: 429 } };
        
        assert.strictEqual(classifyError(errorRateLimit), 'TRANSIENT');
    });

});