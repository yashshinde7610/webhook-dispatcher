// tests/outboxTailer.test.js
//
// CRITICAL: Test pollOutbox directly. Never call startTailer —
// setInterval will prevent the test process from exiting.
//
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    injectMock, createMockRedis, createMockEventModel, createMockLogger,
} = require('./helpers/mocks');

// ── Mock setup ───────────────────────────────────────────────
const mockRedis = createMockRedis();
const mockEvent = createMockEventModel();
const mockLogger = createMockLogger();

// addToQueue(data) spy — single-arg function
const addToQueueSpy = async (data) => { addToQueueSpy._calls.push(data); };
addToQueueSpy._calls = [];
addToQueueSpy._reset = () => { addToQueueSpy._calls = []; };

injectMock('./src/redis', mockRedis);
injectMock('./src/models/Event', mockEvent);
injectMock('./src/queue', { addToQueue: addToQueueSpy, myQueue: {} });
injectMock('./src/utils/logger', mockLogger);

const { pollOutbox } = require('../src/services/outboxTailer');

describe('pollOutbox', () => {
    beforeEach(() => {
        mockEvent._reset();
        addToQueueSpy._reset();
        // Default: lock acquired successfully
        mockRedis.set = async () => 'OK';
    });

    test('acquires lock, finds PENDING events, and enqueues them', async () => {
        mockEvent._findResult = [
            {
                _id: 'event-1',
                url: 'https://example.com/hook',
                payload: '{"data":1}',
                traceId: 'trace-1',
                source: 'API',
                deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
            },
            {
                _id: 'event-2',
                url: 'https://example.com/hook2',
                payload: '{"data":2}',
                traceId: 'trace-2',
                source: 'API',
            },
        ];

        await pollOutbox();

        // Both events should be enqueued
        assert.strictEqual(addToQueueSpy._calls.length, 2);
        assert.strictEqual(addToQueueSpy._calls[0].dbId, 'event-1');
        assert.strictEqual(addToQueueSpy._calls[1].dbId, 'event-2');
    });

    test('skips when lock is already held (another instance tailing)', async () => {
        mockRedis.set = async () => null; // NX fails — lock held

        mockEvent._findResult = [{ _id: 'should-not-be-queued' }];

        await pollOutbox();

        // Should not query DB or enqueue anything
        assert.strictEqual(addToQueueSpy._calls.length, 0);
    });

    test('handles "Job already exists" error gracefully', async () => {
        mockEvent._findResult = [
            {
                _id: 'dup-event',
                url: 'https://example.com/hook',
                payload: '{"x":1}',
                traceId: 'trace-dup',
            },
        ];

        // Override spy to throw "Job already exists"
        const originalAdd = addToQueueSpy;
        const throwingAdd = async () => {
            throw new Error('Job already exists in queue');
        };
        // Temporarily replace the mock's addToQueue
        const queueModule = require.cache[require.resolve('../src/queue')];
        queueModule.exports.addToQueue = throwingAdd;

        // Should not throw — error is swallowed
        await assert.doesNotReject(() => pollOutbox());

        // Restore
        queueModule.exports.addToQueue = addToQueueSpy;
    });

    test('empty result set — no addToQueue calls', async () => {
        mockEvent._findResult = [];

        await pollOutbox();

        assert.strictEqual(addToQueueSpy._calls.length, 0);
    });

    test('defaults deliverySemantics to AT_LEAST_ONCE_UNORDERED when missing', async () => {
        mockEvent._findResult = [
            {
                _id: 'no-semantics',
                url: 'https://example.com/hook',
                payload: '{"x":1}',
                traceId: 'trace-ns',
                // no deliverySemantics field
            },
        ];

        await pollOutbox();

        assert.strictEqual(addToQueueSpy._calls.length, 1);
        assert.strictEqual(
            addToQueueSpy._calls[0].deliverySemantics,
            'AT_LEAST_ONCE_UNORDERED'
        );
    });
});
