// tests/helpers/mocks.js
//
// Centralized mock factories for unit tests. Keeps individual test files
// focused on assertions, not plumbing.

const path = require('path');

// ── Module injection ─────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Inject a mock into Node's require cache so subsequent require()
 * calls for that module path return the mock instead.
 * Paths starting with '..' or '.' are resolved relative to PROJECT_ROOT.
 */
function injectMock(modulePath, mockExport) {
    let resolved;
    if (modulePath.startsWith('.')) {
        resolved = require.resolve(path.resolve(PROJECT_ROOT, modulePath));
    } else {
        resolved = require.resolve(modulePath);
    }
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: mockExport,
    };
}

// ── Logger (no-op) ───────────────────────────────────────────

function createMockLogger() {
    return {
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        debug: () => {},
    };
}

// ── Redis ────────────────────────────────────────────────────

function createMockRedis() {
    return {
        status: 'ready',
        set: async () => 'OK',
        get: async () => null,
        del: async () => {},
        call: async () => {},
    };
}

// ── Queue ────────────────────────────────────────────────────

function createMockQueue() {
    const queue = {
        _addCalls: [],
        _getJobCalls: [],
        _getJobResult: null,

        add: async function (name, data, opts) {
            queue._addCalls.push({ name, data, opts });
        },

        getJob: async function (id) {
            queue._getJobCalls.push(id);
            return queue._getJobResult;
        },

        _reset() {
            queue._addCalls = [];
            queue._getJobCalls = [];
            queue._getJobResult = null;
        },
    };
    return queue;
}

// ── Event Model ──────────────────────────────────────────────

/**
 * Returns a mock Mongoose model constructor with resettable static
 * method stubs. Each test sets Model._findByIdResult etc. for its
 * specific path, and _reset() clears everything between tests.
 */
function createMockEventModel() {
    // Constructor — used by `new Event({...})` in ingestEvent
    const Model = function (data) {
        const doc = {
            ...data,
            _id: data._id || 'mock-id-' + Date.now(),
            save: Model._saveBehavior,
            toObject: () => ({ ...data }),
        };
        return doc;
    };

    // Default find chain — every method returns the chain itself,
    // so any ordering works (sort→skip→limit→lean, sort→limit→lean, etc.)
    function _buildFindChain() {
        const chain = {
            sort: () => chain,
            skip: () => chain,
            limit: () => chain,
            lean: async () => Model._findResult || [],
        };
        return chain;
    }

    // Static methods — each returns the configured _*Result value
    // findById returns a chainable query (supports .lean())
    // The result itself is also the resolved value for `await Event.findById(id)`
    Model.findById = (id) => {
        const result = Model._findByIdResult;
        // Return thenable + chainable: await works directly, .lean() also works
        return {
            lean: async () => result,
            then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
        };
    };
    Model.findOne = async (query) => Model._findOneResult;
    Model.findOneAndUpdate = async (filter, update, opts) => {
        Model._findOneAndUpdateCalls.push({ filter, update, opts });
        return Model._findOneAndUpdateResult;
    };
    Model.findByIdAndUpdate = async (id, update) => {
        Model._findByIdAndUpdateCalls.push({ id, update });
        return Model._findByIdAndUpdateResult;
    };
    Model.findByIdAndDelete = async (id) => Model._findByIdAndDeleteResult;
    Model.find = (filter) => {
        Model._findCalls.push(filter);
        return _buildFindChain();
    };
    Model.countDocuments = async (filter) => {
        Model._countDocumentsCalls.push(filter);
        return Model._countResult;
    };
    Model.updateOne = async (filter, update, options) => {
        Model._updateOneCalls.push({ filter, update, options });
        return Model._updateOneResult || { modifiedCount: 1 };
    };

    // Statics used in application code
    Model.MAX_LOGS = 20;
    Model.TTL_SECONDS = 2592000;

    // Default behaviors
    Model._saveBehavior = async function () { return this; };

    // Result storage
    Model._findByIdResult = null;
    Model._findOneResult = null;
    Model._findOneAndUpdateResult = null;
    Model._findByIdAndUpdateResult = null;
    Model._findByIdAndDeleteResult = null;
    Model._findResult = [];
    Model._countResult = 0;
    Model._updateOneResult = { modifiedCount: 1 };

    // Call recording
    Model._findOneAndUpdateCalls = [];
    Model._findByIdAndUpdateCalls = [];
    Model._findCalls = [];
    Model._countDocumentsCalls = [];
    Model._updateOneCalls = [];

    Model._reset = function () {
        Model._saveBehavior = async function () { return this; };
        Model._findByIdResult = null;
        Model._findOneResult = null;
        Model._findOneAndUpdateResult = null;
        Model._findByIdAndUpdateResult = null;
        Model._findByIdAndDeleteResult = null;
        Model._findResult = [];
        Model._countResult = 0;
        Model._updateOneResult = { modifiedCount: 1 };
        Model._findOneAndUpdateCalls = [];
        Model._findByIdAndUpdateCalls = [];
        Model._findCalls = [];
        Model._countDocumentsCalls = [];
        Model._updateOneCalls = [];
    };

    return Model;
}

// ── Express req/res ──────────────────────────────────────────

/**
 * Creates mock Express req/res objects with call recording.
 * res supports both res.json() (direct) and res.status(code).json() (chained).
 */
function createMockReqRes(body = {}, headers = {}, params = {}, query = {}) {
    const res = {
        _statusCode: 200,
        _body: null,

        // Direct json call (no preceding status() — defaults to 200)
        json(data) {
            res._body = data;
            return res;
        },

        // Chained status().json()
        status(code) {
            res._statusCode = code;
            return res;  // enables res.status(400).json(...)
        },
    };

    const req = {
        body,
        headers: { ...headers },
        params: { ...params },
        query: { ...query },
        app: {
            locals: {
                enqueueJobUpdate: () => {},
            },
        },
    };

    return { req, res };
}

module.exports = {
    injectMock,
    createMockLogger,
    createMockRedis,
    createMockQueue,
    createMockEventModel,
    createMockReqRes,
};
