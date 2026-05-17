// tests/batchProcessor.test.js
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { injectMock, createMockEventModel } = require('./helpers/mocks');

// ── Mock setup ───────────────────────────────────────────────
const mockEvent = createMockEventModel();
injectMock('./src/models/Event', mockEvent);

const { persistState } = require('../src/batchProcessor');

describe('persistState', () => {
    beforeEach(() => mockEvent._reset());

    test('skips when no dbId is provided', async () => {
        await persistState({});
        assert.strictEqual(mockEvent._updateOneCalls.length, 0);
    });

    test('sets correct $set fields for COMPLETED state', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'COMPLETED',
            httpStatus: 200,
        });

        assert.strictEqual(mockEvent._updateOneCalls.length, 1);
        const { filter, update } = mockEvent._updateOneCalls[0];
        assert.strictEqual(filter._id, 'abc123');
        assert.strictEqual(update.$set.status, 'COMPLETED');
        assert.strictEqual(update.$set.finalHttpStatus, 200);
        assert.strictEqual(update.$set.failureType, null);
        assert.strictEqual(update.$set.lastError, null);
    });

    test('sets failure fields for FAILED state', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'FAILED',
            failureType: 'TRANSIENT',
            lastError: 'Connection refused',
            errorCode: 'ECONNREFUSED',
        });

        const { update } = mockEvent._updateOneCalls[0];
        assert.strictEqual(update.$set.status, 'FAILED');
        assert.strictEqual(update.$set.failureType, 'TRANSIENT');
        assert.strictEqual(update.$set.lastError, 'Connection refused');
        assert.strictEqual(update.$set.errorCode, 'ECONNREFUSED');
    });

    test('appends log entry with $push and $slice', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'COMPLETED',
            logEntry: { attempt: 1, status: 200, response: 'OK' },
        });

        const { update } = mockEvent._updateOneCalls[0];
        assert.ok(update.$push, '$push should be set');
        assert.ok(update.$push.logs, '$push.logs should be set');
        assert.deepStrictEqual(update.$push.logs.$each, [
            { attempt: 1, status: 200, response: 'OK' },
        ]);
        assert.strictEqual(update.$push.logs.$slice, -20);
    });

    test('incrementAttempt adds $inc', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'COMPLETED',
            incrementAttempt: true,
        });

        const { update } = mockEvent._updateOneCalls[0];
        assert.ok(update.$inc, '$inc should be set');
        assert.strictEqual(update.$inc.attemptCount, 1);
    });

    test('upsert sets $setOnInsert and options.upsert', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'PENDING',
            upsert: true,
            initialData: { url: 'https://example.com', source: 'API' },
        });

        const { update, options } = mockEvent._updateOneCalls[0];
        assert.strictEqual(options.upsert, true);
        assert.deepStrictEqual(update.$setOnInsert, {
            url: 'https://example.com',
            source: 'API',
        });
    });

    test('httpStatus sanitization — numeric maps to finalHttpStatus', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'COMPLETED',
            httpStatus: 200,
        });

        const { update } = mockEvent._updateOneCalls[0];
        assert.strictEqual(update.$set.finalHttpStatus, 200);
    });

    test('httpStatus sanitization — non-numeric string maps to errorCode', async () => {
        await persistState({
            dbId: 'abc123',
            status: 'FAILED',
            httpStatus: 'ECONNREFUSED',
        });

        const { update } = mockEvent._updateOneCalls[0];
        assert.strictEqual(update.$set.finalHttpStatus, null);
        assert.strictEqual(update.$set.errorCode, 'ECONNREFUSED');
    });
});
