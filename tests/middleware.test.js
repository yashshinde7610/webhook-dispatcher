// tests/middleware.test.js
//
// Tests for safeCompare and validateApiKey.
// We import them by extracting from the middleware module after injecting
// a mock redis that satisfies RedisStore's async initialization.
//
const { test, describe } = require('node:test');
const assert = require('node:assert');

// RedisStore calls redis.call() asynchronously to initialize.
// Our mock must return proper values to avoid unhandledRejection.
const { injectMock } = require('./helpers/mocks');

const mockRedis = {
    status: 'ready',
    // RedisStore sendCommand calls redis.call which must return valid
    // rate-limit-redis expects string/number responses from Redis commands
    call: async (...args) => {
        // EVALSHA / EVAL commands expect array responses
        if (args[0] === 'EVALSHA' || args[0] === 'EVAL') return [0, -1];
        return 'OK';
    },
};
injectMock('./src/redis', mockRedis);

const { safeCompare, validateApiKey } = require('../src/api/middleware');

describe('safeCompare', () => {
    test('equal values return true', () => {
        assert.strictEqual(safeCompare('my-secret-key', 'my-secret-key'), true);
    });

    test('unequal values return false', () => {
        assert.strictEqual(safeCompare('correct', 'wrong'), false);
    });

    test('different length strings return false', () => {
        assert.strictEqual(safeCompare('short', 'much-longer-string'), false);
    });

    test('null/undefined inputs return false', () => {
        assert.strictEqual(safeCompare(null, 'key'), false);
        assert.strictEqual(safeCompare('key', undefined), false);
        assert.strictEqual(safeCompare(null, undefined), true); // both coerce to ''
    });

    test('empty strings are equal', () => {
        assert.strictEqual(safeCompare('', ''), true);
    });
});

describe('validateApiKey', () => {
    const originalApiKey = process.env.API_KEY;

    test('valid API key calls next()', () => {
        process.env.API_KEY = 'test-api-key-123';

        let nextCalled = false;
        const req = { headers: { 'x-api-key': 'test-api-key-123' } };
        const res = {
            _statusCode: 200,
            _body: null,
            status(code) { res._statusCode = code; return res; },
            json(data) { res._body = data; return res; },
        };

        validateApiKey(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
        process.env.API_KEY = originalApiKey;
    });

    test('invalid API key returns 403', () => {
        process.env.API_KEY = 'test-api-key-123';

        let nextCalled = false;
        const req = { headers: { 'x-api-key': 'wrong-key' } };
        const res = {
            _statusCode: 200,
            _body: null,
            status(code) { res._statusCode = code; return res; },
            json(data) { res._body = data; return res; },
        };

        validateApiKey(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res._statusCode, 403);
        assert.ok(res._body.error.includes('Access Denied'));
        process.env.API_KEY = originalApiKey;
    });

    test('missing x-api-key header returns 403', () => {
        process.env.API_KEY = 'test-api-key-123';

        let nextCalled = false;
        const req = { headers: {} };
        const res = {
            _statusCode: 200,
            _body: null,
            status(code) { res._statusCode = code; return res; },
            json(data) { res._body = data; return res; },
        };

        validateApiKey(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res._statusCode, 403);
        process.env.API_KEY = originalApiKey;
    });
});
