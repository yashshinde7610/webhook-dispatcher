// tests/controller.test.js
//
// Unit tests for all eventController endpoints.
// Uses require.cache injection to mock Event model, redis, queue, and logger.
//
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    injectMock, createMockLogger, createMockRedis,
    createMockQueue, createMockEventModel, createMockReqRes,
} = require('./helpers/mocks');

// ── Mock setup (must happen before requiring the controller) ─

const mockRedis = createMockRedis();
const mockQueue = createMockQueue();
const mockEvent = createMockEventModel();
const mockLogger = createMockLogger();

// Inject mocks into require cache
// addToQueue(data) takes a single arg — wrap it as a proper spy
const addToQueueSpy = async (data) => { addToQueueSpy._calls.push(data); };
addToQueueSpy._calls = [];
addToQueueSpy._reset = () => { addToQueueSpy._calls = []; };

injectMock('./src/redis', mockRedis);
injectMock('./src/utils/logger', mockLogger);
injectMock('./src/models/Event', mockEvent);
injectMock('./src/queue', { addToQueue: addToQueueSpy, myQueue: mockQueue });

// Now require the controller — it will get our mocks
const controller = require('../src/api/controllers/eventController');

// Valid ObjectId for test paths
const VALID_ID = '507f1f77bcf86cd799439011';
const INVALID_ID = 'not-a-valid-id';

// ── ingestEvent ──────────────────────────────────────────────

describe('ingestEvent', () => {
    beforeEach(() => {
        mockEvent._reset();
        mockQueue._reset();
        addToQueueSpy._reset();
        mockRedis.status = 'ready';
    });

    test('202 happy path — event saved to MongoDB (outbox tailer enqueues)', async () => {
        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook', payload: { data: 1 } }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 202);
        assert.strictEqual(res._body.status, 'accepted');
        assert.strictEqual(res._body.message, 'Event accepted');
        assert.ok(res._body.id, 'should return event ID');
        assert.ok(res._body.traceId, 'should return traceId');
        // addToQueue should NOT be called — outbox tailer handles enqueuing
        assert.strictEqual(addToQueueSpy._calls.length, 0);
    });

    test('400 — missing url fails validation', async () => {
        const { req, res } = createMockReqRes(
            { payload: { data: 1 } }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'VALIDATION_FAILED');
    });

    test('400 — missing payload fails validation', async () => {
        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook' }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'VALIDATION_FAILED');
    });

    test('409 — E11000 idempotency collision', async () => {
        mockEvent._saveBehavior = async function () {
            const err = new Error('E11000 duplicate key');
            err.code = 11000;
            throw err;
        };
        mockEvent._findOneResult = { _id: VALID_ID, status: 'COMPLETED' };

        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook', payload: { data: 1 } },
            { 'idempotency-key': 'unique-key-1' }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 409);
        assert.strictEqual(res._body.existingId, VALID_ID);
    });

    test('500 — save() throws non-E11000 error', async () => {
        mockEvent._saveBehavior = async function () {
            throw new Error('Disk full');
        };

        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook', payload: { data: 1 } }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 500);
        assert.strictEqual(res._body.error, 'Internal Server Error');
    });
});

// ── ingestEvent force retry ──────────────────────────────────

describe('ingestEvent — force retry', () => {
    beforeEach(() => {
        mockEvent._reset();
        mockQueue._reset();
        addToQueueSpy._reset();
        mockRedis.status = 'ready';
    });

    test('202 — existing non-PENDING event is force-retried', async () => {
        mockEvent._findOneAndUpdateResult = {
            _id: VALID_ID,
            url: 'https://example.com/hook',
            payload: '{"data":1}',
            traceId: 'trace-1',
            source: 'API_KEY_USER',
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
        };

        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook', payload: { data: 1 } },
            { 'idempotency-key': 'key-1', 'x-force-retry': 'true' }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 202);
        assert.strictEqual(res._body.message, 'Force retry queued');
        // addToQueue should NOT be called — outbox tailer handles enqueuing
        assert.strictEqual(addToQueueSpy._calls.length, 0);
    });

    test('409 — event is already PENDING (conflict)', async () => {
        // findOneAndUpdate returns null (status guard $ne: PENDING doesn't match)
        mockEvent._findOneAndUpdateResult = null;
        // findOne finds the event but it's PENDING
        mockEvent._findOneResult = { _id: VALID_ID, status: 'PENDING' };

        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook', payload: { data: 1 } },
            { 'idempotency-key': 'key-1', 'x-force-retry': 'true' }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 409);
        assert.ok(res._body.message.includes('already pending'));
    });

    test('404 — no event exists for idempotency key', async () => {
        mockEvent._findOneAndUpdateResult = null;
        mockEvent._findOneResult = null;

        const { req, res } = createMockReqRes(
            { url: 'https://example.com/hook', payload: { data: 1 } },
            { 'idempotency-key': 'nonexistent-key', 'x-force-retry': 'true' }
        );

        await controller.ingestEvent(req, res);

        assert.strictEqual(res._statusCode, 404);
    });
});

// ── replayEvent ──────────────────────────────────────────────

describe('replayEvent', () => {
    beforeEach(() => {
        mockEvent._reset();
        mockQueue._reset();
        addToQueueSpy._reset();
    });

    test('200 — replays existing event', async () => {
        mockEvent._findByIdResult = {
            _id: VALID_ID,
            url: 'https://example.com/hook',
            payload: '{"data":1}',
            traceId: 'trace-1',
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
            logs: [],
        };

        const { req, res } = createMockReqRes({}, {}, { id: VALID_ID });

        await controller.replayEvent(req, res);

        assert.strictEqual(res._statusCode, 200);
        assert.strictEqual(res._body.message, 'Replay started');
        // Controller no longer calls myQueue.add() — outbox tailer handles enqueuing
        assert.strictEqual(mockQueue._addCalls.length, 0);
    });

    test('400 — invalid ObjectId', async () => {
        const { req, res } = createMockReqRes({}, {}, { id: INVALID_ID });

        await controller.replayEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
    });

    test('404 — event not found', async () => {
        mockEvent._findByIdResult = null;
        const { req, res } = createMockReqRes({}, {}, { id: VALID_ID });

        await controller.replayEvent(req, res);

        assert.strictEqual(res._statusCode, 404);
    });
});

// ── patchEvent ───────────────────────────────────────────────

describe('patchEvent', () => {
    beforeEach(() => {
        mockEvent._reset();
        mockEvent._updateOneResult = { matchedCount: 1, modifiedCount: 1 };
    });

    test('200 — patches event with valid mask and body', async () => {
        const { req, res } = createMockReqRes(
            { url: 'https://new-url.com/hook' },
            {},
            { id: VALID_ID },
            { updateMask: 'url' }
        );

        await controller.patchEvent(req, res);

        assert.strictEqual(res._statusCode, 200);
        assert.ok(res._body.updatedFields.includes('url'));
    });

    test('400 — invalid ObjectId', async () => {
        const { req, res } = createMockReqRes(
            { url: 'https://new-url.com' },
            {},
            { id: INVALID_ID },
            { updateMask: 'url' }
        );

        await controller.patchEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'INVALID_ID');
    });

    test('404 — event not found', async () => {
        mockEvent._updateOneResult = { matchedCount: 0, modifiedCount: 0 };
        const { req, res } = createMockReqRes(
            { url: 'https://new-url.com' },
            {},
            { id: VALID_ID },
            { updateMask: 'url' }
        );

        await controller.patchEvent(req, res);

        assert.strictEqual(res._statusCode, 404);
    });

    test('400 — validation failure (invalid url)', async () => {
        const { req, res } = createMockReqRes(
            { url: 'not-a-url' },
            {},
            { id: VALID_ID },
            { updateMask: 'url' }
        );

        await controller.patchEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'PATCH_VALIDATION_FAILED');
    });

    test('400 — updateMask = "*" produces INVALID_FIELD_MASK', async () => {
        const { req, res } = createMockReqRes(
            { url: 'https://valid.com' },
            {},
            { id: VALID_ID },
            { updateMask: '*' }
        );

        await controller.patchEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'INVALID_FIELD_MASK');
    });

    test('status field is stripped by patchSchema (worker-owned)', async () => {
        const { req, res } = createMockReqRes(
            { url: 'https://valid.com', status: 'COMPLETED' },
            {},
            { id: VALID_ID },
            { updateMask: 'url,status' }
        );

        await controller.patchEvent(req, res);

        // patchSchema has stripUnknown, so status is removed.
        // Only url should be in the update.
        assert.strictEqual(res._statusCode, 200);
        assert.ok(res._body.updatedFields.includes('url'));
        assert.ok(!res._body.updatedFields.includes('status'));
    });
});

// ── getEventById ─────────────────────────────────────────────

describe('getEventById', () => {
    beforeEach(() => mockEvent._reset());

    test('200 — returns event by ID', async () => {
        mockEvent._findByIdResult = {
            _id: VALID_ID,
            url: 'https://example.com',
            payload: '{"name":"test"}',
            status: 'COMPLETED',
        };
        const { req, res } = createMockReqRes({}, {}, { id: VALID_ID });

        await controller.getEventById(req, res);

        assert.strictEqual(res._statusCode, 200);
        assert.strictEqual(res._body._id, VALID_ID);
    });

    test('400 — invalid ObjectId', async () => {
        const { req, res } = createMockReqRes({}, {}, { id: INVALID_ID });

        await controller.getEventById(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'INVALID_ID');
    });

    test('404 — event not found', async () => {
        mockEvent._findByIdResult = null;
        const { req, res } = createMockReqRes({}, {}, { id: VALID_ID });

        await controller.getEventById(req, res);

        assert.strictEqual(res._statusCode, 404);
    });
});

// ── getEvents ────────────────────────────────────────────────

describe('getEvents', () => {
    beforeEach(() => mockEvent._reset());

    test('200 — returns paginated events', async () => {
        mockEvent._findResult = [
            { _id: '1', url: 'https://a.com', payload: '{"x":1}', status: 'COMPLETED' },
            { _id: '2', url: 'https://b.com', payload: '{"y":2}', status: 'PENDING' },
        ];
        mockEvent._countResult = 42;

        const { req, res } = createMockReqRes({}, {}, {}, { page: '1', limit: '20' });

        await controller.getEvents(req, res);

        assert.strictEqual(res._statusCode, 200);
        assert.strictEqual(res._body.events.length, 2);
        assert.strictEqual(res._body.pagination.total, 42);
        assert.strictEqual(res._body.pagination.page, 1);
        assert.strictEqual(res._body.pagination.limit, 20);
        assert.strictEqual(res._body.pagination.pages, 3); // ceil(42/20)
    });
});

// ── deleteEvent ──────────────────────────────────────────────

describe('deleteEvent', () => {
    beforeEach(() => mockEvent._reset());

    test('200 — deletes existing event', async () => {
        mockEvent._findByIdAndDeleteResult = { _id: VALID_ID };
        const { req, res } = createMockReqRes({}, {}, { id: VALID_ID });

        await controller.deleteEvent(req, res);

        assert.strictEqual(res._statusCode, 200);
        assert.strictEqual(res._body.message, 'Event deleted');
    });

    test('400 — invalid ObjectId', async () => {
        const { req, res } = createMockReqRes({}, {}, { id: INVALID_ID });

        await controller.deleteEvent(req, res);

        assert.strictEqual(res._statusCode, 400);
        assert.strictEqual(res._body.code, 'INVALID_ID');
    });

    test('404 — event not found', async () => {
        mockEvent._findByIdAndDeleteResult = null;
        const { req, res } = createMockReqRes({}, {}, { id: VALID_ID });

        await controller.deleteEvent(req, res);

        assert.strictEqual(res._statusCode, 404);
    });
});
