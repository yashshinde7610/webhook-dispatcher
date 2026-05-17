// tests/zombieSweeper.test.js
//
// CRITICAL: Test sweepZombies directly. Never call startSweeper —
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

const { sweepZombies } = require('../src/services/zombieSweeper');

describe('sweepZombies', () => {
    beforeEach(() => {
        mockEvent._reset();
        addToQueueSpy._reset();
        // Default: lock acquired successfully
        mockRedis.set = async () => 'OK';
    });

    test('acquires lock, finds stale events, and re-queues them', async () => {
        mockEvent._findResult = [
            {
                _id: 'zombie-1',
                url: 'https://example.com/hook',
                payload: '{"data":1}',
                traceId: 'trace-z1',
                source: 'API',
                deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
            },
            {
                _id: 'zombie-2',
                url: 'https://example.com/hook2',
                payload: '{"data":2}',
                traceId: 'trace-z2',
                source: 'API',
            },
        ];

        await sweepZombies();

        // Both zombies should be re-queued
        assert.strictEqual(addToQueueSpy._calls.length, 2);
        assert.strictEqual(addToQueueSpy._calls[0].dbId, 'zombie-1');
        assert.strictEqual(addToQueueSpy._calls[1].dbId, 'zombie-2');
    });

    test('skips when lock is already held (another instance sweeping)', async () => {
        mockRedis.set = async () => null; // NX fails — lock held

        mockEvent._findResult = [{ _id: 'should-not-be-queued' }];

        await sweepZombies();

        // Should not query DB or enqueue anything
        assert.strictEqual(addToQueueSpy._calls.length, 0);
    });

    test('handles "Job already exists" error gracefully', async () => {
        mockEvent._findResult = [
            {
                _id: 'dup-zombie',
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
        await assert.doesNotReject(() => sweepZombies());

        // Restore
        queueModule.exports.addToQueue = addToQueueSpy;
    });

    test('empty result set — no addToQueue calls', async () => {
        mockEvent._findResult = [];

        await sweepZombies();

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

        await sweepZombies();

        assert.strictEqual(addToQueueSpy._calls.length, 1);
        assert.strictEqual(
            addToQueueSpy._calls[0].deliverySemantics,
            'AT_LEAST_ONCE_UNORDERED'
        );
    });
});
