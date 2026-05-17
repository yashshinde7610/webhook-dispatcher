// tests/worker.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { classifyError, safeHttpStatus, createHmacSignature } = require('../src/utils/workerUtils');

describe('Error Classification', () => {

    test('network errors (ECONNREFUSED, ETIMEDOUT) are TRANSIENT', () => {
        assert.strictEqual(classifyError({ code: 'ECONNREFUSED' }), 'TRANSIENT');
        assert.strictEqual(classifyError({ code: 'ETIMEDOUT' }), 'TRANSIENT');
        assert.strictEqual(classifyError({ code: 'ECONNABORTED' }), 'TRANSIENT');
    });

    test('ENOTFOUND (domain does not exist) is PERMANENT', () => {
        assert.strictEqual(classifyError({ code: 'ENOTFOUND' }), 'PERMANENT');
    });

    test('EAI_AGAIN (DNS resolver temporarily unavailable) is TRANSIENT', () => {
        assert.strictEqual(classifyError({ code: 'EAI_AGAIN' }), 'TRANSIENT');
    });

    test('4xx client errors are PERMANENT (no point retrying)', () => {
        assert.strictEqual(classifyError({ response: { status: 400 } }), 'PERMANENT');
        assert.strictEqual(classifyError({ response: { status: 404 } }), 'PERMANENT');
        assert.strictEqual(classifyError({ response: { status: 422 } }), 'PERMANENT');
    });

    test('429 and 5xx are TRANSIENT (server might recover)', () => {
        assert.strictEqual(classifyError({ response: { status: 429 } }), 'TRANSIENT');
        assert.strictEqual(classifyError({ response: { status: 500 } }), 'TRANSIENT');
        assert.strictEqual(classifyError({ response: { status: 503 } }), 'TRANSIENT');
    });

    test('circuit breaker open is TRANSIENT', () => {
        assert.strictEqual(classifyError({ message: 'Circuit Breaker Open' }), 'TRANSIENT');
    });
});

describe('HTTP Status Sanitization', () => {

    test('valid numbers pass through', () => {
        assert.strictEqual(safeHttpStatus(200), 200);
        assert.strictEqual(safeHttpStatus(404), 404);
    });

    test('numeric strings are coerced', () => {
        assert.strictEqual(safeHttpStatus('500'), 500);
    });

    test('garbage returns null', () => {
        assert.strictEqual(safeHttpStatus(undefined), null);
        assert.strictEqual(safeHttpStatus(''), null);
        assert.strictEqual(safeHttpStatus('not-a-number'), null);
        assert.strictEqual(safeHttpStatus(NaN), null);
    });

    test('edge cases: Infinity and boolean return null', () => {
        assert.strictEqual(safeHttpStatus(Infinity), null);
        assert.strictEqual(safeHttpStatus(true), null);
    });
});

describe('HMAC Signature', () => {

    test('produces consistent hex digest for the same input', () => {
        const sig1 = createHmacSignature('{"test":true}', 'secret');
        const sig2 = createHmacSignature('{"test":true}', 'secret');
        assert.strictEqual(sig1, sig2);
        assert.strictEqual(sig1.length, 64); // SHA-256 = 64 hex chars
    });

    test('different payloads produce different signatures', () => {
        const sig1 = createHmacSignature('{"a":1}', 'secret');
        const sig2 = createHmacSignature('{"a":2}', 'secret');
        assert.notStrictEqual(sig1, sig2);
    });

    test('throws if secret is missing', () => {
        assert.throws(() => createHmacSignature('{}', ''), /WEBHOOK_SECRET/);
        assert.throws(() => createHmacSignature('{}', null), /WEBHOOK_SECRET/);
    });
});