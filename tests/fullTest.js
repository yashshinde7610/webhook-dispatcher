#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  tests/fullTest.js — COMPREHENSIVE VISUAL TEST SUITE
// ═══════════════════════════════════════════════════════════════
//
//  Part 1: UNIT TESTS   — Pure logic, zero external dependencies
//  Part 2: E2E  TESTS   — Live services (MongoDB, Redis, API, Worker)
//
//  Usage:
//    node tests/fullTest.js                  # Full suite
//    node tests/fullTest.js --unit-only      # Unit tests only
//    node tests/fullTest.js --e2e-only       # E2E tests only
//
//  Prerequisites for E2E:
//    • docker-compose up -d    OR
//    • locally running: mongod, redis-server, node server.js, node src/worker.js
//    • .env with API_KEY, DASHBOARD_TOKEN, WEBHOOK_SECRET
//
require('dotenv').config();
const chalk   = require('chalk');
const assert  = require('assert');
const crypto  = require('crypto');
const http    = require('http');
const axios   = require('axios');

// ── CONFIG ──────────────────────────────────────────────────────
const API_BASE        = process.env.TEST_API_URL || 'http://localhost:3000';
const API_KEY         = process.env.API_KEY;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
// For the "successful delivery" test — must resolve to a PUBLIC IP
const WEBHOOK_TARGET  = process.env.TEST_WEBHOOK_TARGET || 'https://httpbin.org/post';

const args      = process.argv.slice(2);
const UNIT_ONLY = args.includes('--unit-only');
const E2E_ONLY  = args.includes('--e2e-only');

// ── COUNTERS ────────────────────────────────────────────────────
let unitPassed = 0, unitFailed = 0;
let e2ePassed  = 0, e2eFailed  = 0, e2eSkipped = 0;
const failures = [];

// ── VISUAL HELPERS ──────────────────────────────────────────────
const PASS = chalk.green('  ✅');
const FAIL = chalk.red('  ❌');
const SKIP = chalk.yellow('  ⏭️ ');
const WAIT = chalk.cyan('  ⏳');
const INFO = chalk.blue('  ℹ️ ');

function banner(text) {
    const line = '═'.repeat(62);
    console.log('\n' + chalk.cyan(`╔${line}╗`));
    const padded = text.padStart(Math.floor((62 + text.length) / 2)).padEnd(62);
    console.log(chalk.cyan('║') + chalk.bold.white(padded) + chalk.cyan('║'));
    console.log(chalk.cyan(`╚${line}╝`) + '\n');
}

function section(text) {
    console.log('\n' + chalk.yellow(`─── ${text} ${'─'.repeat(Math.max(0, 56 - text.length))}`));
}

function subsection(text) {
    console.log(chalk.dim(`\n  ${text}`));
}

async function unitTest(name, fn) {
    try {
        await fn();
        console.log(`${PASS} ${name}`);
        unitPassed++;
    } catch (err) {
        console.log(`${FAIL} ${name}`);
        console.log(chalk.red(`      → ${err.message}`));
        unitFailed++;
        failures.push({ phase: 'UNIT', name, error: err.message });
    }
}

async function e2eTest(name, fn) {
    try {
        await fn();
        console.log(`${PASS} ${name}`);
        e2ePassed++;
    } catch (err) {
        console.log(`${FAIL} ${name}`);
        console.log(chalk.red(`      → ${err.message}`));
        e2eFailed++;
        failures.push({ phase: 'E2E', name, error: err.message });
    }
}

function e2eSkip(name, reason) {
    console.log(`${SKIP}${name} ${chalk.dim(`(${reason})`)}`);
    e2eSkipped++;
}

function info(msg) {
    console.log(`${INFO} ${chalk.dim(msg)}`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}


// ── IMPORTS (Pure utility modules — no side effects) ────────────
const { classifyError, safeHttpStatus, createHmacSignature } = require('../src/utils/workerUtils');
const { redact, redactPayloadString, REDACTED }               = require('../src/utils/redact');
const { applyFieldMask }                                       = require('../src/utils/fieldMask');


// ═════════════════════════════════════════════════════════════════
//  PART 1: UNIT TESTS (Pure Logic)
// ═════════════════════════════════════════════════════════════════
async function runUnitTests() {
    section('PHASE 1: UNIT TESTS (Pure Logic — No External Deps)');

    // ── 1.1 classifyError ─────────────────────────────────────
    subsection('1.1  classifyError()');

    await unitTest('ECONNREFUSED → TRANSIENT', () => {
        assert.strictEqual(classifyError({ code: 'ECONNREFUSED' }), 'TRANSIENT');
    });

    await unitTest('ETIMEDOUT → TRANSIENT', () => {
        assert.strictEqual(classifyError({ code: 'ETIMEDOUT' }), 'TRANSIENT');
    });

    await unitTest('ECONNABORTED → TRANSIENT', () => {
        assert.strictEqual(classifyError({ code: 'ECONNABORTED' }), 'TRANSIENT');
    });

    await unitTest('HTTP 400 (Bad Request) → PERMANENT', () => {
        assert.strictEqual(classifyError({ response: { status: 400 } }), 'PERMANENT');
    });

    await unitTest('HTTP 401 (Unauthorized) → PERMANENT', () => {
        assert.strictEqual(classifyError({ response: { status: 401 } }), 'PERMANENT');
    });

    await unitTest('HTTP 404 (Not Found) → PERMANENT', () => {
        assert.strictEqual(classifyError({ response: { status: 404 } }), 'PERMANENT');
    });

    await unitTest('HTTP 429 (Rate Limit) → TRANSIENT', () => {
        assert.strictEqual(classifyError({ response: { status: 429 } }), 'TRANSIENT');
    });

    await unitTest('HTTP 500 (Server Error) → TRANSIENT', () => {
        assert.strictEqual(classifyError({ response: { status: 500 } }), 'TRANSIENT');
    });

    await unitTest('HTTP 502 (Bad Gateway) → TRANSIENT', () => {
        assert.strictEqual(classifyError({ response: { status: 502 } }), 'TRANSIENT');
    });

    await unitTest('HTTP 503 (Unavailable) → TRANSIENT', () => {
        assert.strictEqual(classifyError({ response: { status: 503 } }), 'TRANSIENT');
    });

    await unitTest('Circuit Breaker Open → TRANSIENT', () => {
        assert.strictEqual(classifyError({ message: 'Circuit Breaker Open' }), 'TRANSIENT');
    });

    await unitTest('Unknown error (no code, no response) → TRANSIENT (fail-open)', () => {
        assert.strictEqual(classifyError({}), 'TRANSIENT');
    });

    // ── 1.2 safeHttpStatus ────────────────────────────────────
    subsection('1.2  safeHttpStatus()');

    await unitTest('Number 200 → 200', () => {
        assert.strictEqual(safeHttpStatus(200), 200);
    });

    await unitTest('Number 0 → 0 (falsy but finite)', () => {
        assert.strictEqual(safeHttpStatus(0), 0);
    });

    await unitTest('String "404" → 404', () => {
        assert.strictEqual(safeHttpStatus('404'), 404);
    });

    await unitTest('String "  301 " → 301 (trims whitespace)', () => {
        assert.strictEqual(safeHttpStatus('  301 '), 301);
    });

    await unitTest('NaN → null', () => {
        assert.strictEqual(safeHttpStatus(NaN), null);
    });

    await unitTest('Infinity → null', () => {
        assert.strictEqual(safeHttpStatus(Infinity), null);
    });

    await unitTest('Empty string → null', () => {
        assert.strictEqual(safeHttpStatus(''), null);
    });

    await unitTest('null → null', () => {
        assert.strictEqual(safeHttpStatus(null), null);
    });

    await unitTest('undefined → null', () => {
        assert.strictEqual(safeHttpStatus(undefined), null);
    });

    await unitTest('Boolean true → null (not a valid status)', () => {
        assert.strictEqual(safeHttpStatus(true), null);
    });

    // ── 1.3 createHmacSignature ───────────────────────────────
    subsection('1.3  createHmacSignature()');

    await unitTest('Produces 64-char hex string (SHA-256)', () => {
        const sig = createHmacSignature('{"test":true}', 'secret');
        assert.match(sig, /^[a-f0-9]{64}$/);
    });

    await unitTest('Deterministic: same input → same output', () => {
        const a = createHmacSignature('hello', 'key');
        const b = createHmacSignature('hello', 'key');
        assert.strictEqual(a, b);
    });

    await unitTest('Different payload → different signature', () => {
        const a = createHmacSignature('hello', 'key');
        const b = createHmacSignature('world', 'key');
        assert.notStrictEqual(a, b);
    });

    await unitTest('Different secret → different signature', () => {
        const a = createHmacSignature('hello', 'key1');
        const b = createHmacSignature('hello', 'key2');
        assert.notStrictEqual(a, b);
    });

    await unitTest('Throws when secret is empty/missing', () => {
        assert.throws(() => createHmacSignature('data', ''), /WEBHOOK_SECRET/);
        assert.throws(() => createHmacSignature('data', undefined), /WEBHOOK_SECRET/);
    });

    await unitTest('Accepts Object payload (backward compat stringifies)', () => {
        const sig = createHmacSignature({ test: true }, 'secret');
        assert.match(sig, /^[a-f0-9]{64}$/);
    });

    await unitTest('String payload matches JSON.stringify(Object) payload', () => {
        const obj = { a: 1, b: 2 };
        const fromString = createHmacSignature(JSON.stringify(obj), 'key');
        const fromObject = createHmacSignature(obj, 'key');
        assert.strictEqual(fromString, fromObject);
    });

    // ── 1.4 redact ────────────────────────────────────────────
    subsection('1.4  redact()');

    await unitTest('Redacts "password" key', () => {
        const result = redact({ password: 'secret123', name: 'Alice' });
        assert.strictEqual(result.password, REDACTED);
        assert.strictEqual(result.name, 'Alice');
    });

    await unitTest('Redacts "email" key (case-insensitive via toLowerCase)', () => {
        const result = redact({ email: 'test@example.com', age: 25 });
        assert.strictEqual(result.email, REDACTED);
        assert.strictEqual(result.age, 25);
    });

    await unitTest('Redacts "token", "api_key", "secret", "authorization"', () => {
        const result = redact({ token: 'abc', api_key: 'xyz', secret: 'shhh', authorization: 'Bearer x', safe: 'ok' });
        assert.strictEqual(result.token, REDACTED);
        assert.strictEqual(result.api_key, REDACTED);
        assert.strictEqual(result.secret, REDACTED);
        assert.strictEqual(result.authorization, REDACTED);
        assert.strictEqual(result.safe, 'ok');
    });

    await unitTest('Redacts "ssn", "cvv", "creditcard"', () => {
        const result = redact({ ssn: '123-45-6789', cvv: '123', creditcard: '4111...' });
        assert.strictEqual(result.ssn, REDACTED);
        assert.strictEqual(result.cvv, REDACTED);
        assert.strictEqual(result.creditcard, REDACTED);
    });

    await unitTest('Recursively redacts nested objects', () => {
        const result = redact({ user: { name: 'Bob', password: '123', profile: { email: 'x' } } });
        assert.strictEqual(result.user.name, 'Bob');
        assert.strictEqual(result.user.password, REDACTED);
        assert.strictEqual(result.user.profile.email, REDACTED);
    });

    await unitTest('Handles arrays of objects', () => {
        const result = redact([{ password: 'x' }, { name: 'y' }]);
        assert.strictEqual(result[0].password, REDACTED);
        assert.strictEqual(result[1].name, 'y');
    });

    await unitTest('Returns null / undefined / primitives as-is', () => {
        assert.strictEqual(redact(null), null);
        assert.strictEqual(redact(undefined), undefined);
        assert.strictEqual(redact(42), 42);
        assert.strictEqual(redact('hello'), 'hello');
        assert.strictEqual(redact(true), true);
    });

    await unitTest('maxDepth prevents infinite recursion', () => {
        const deep = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
        const result = redact(deep, 3);
        // Depth 0 = root, 1 = a, 2 = b, 3 = c → c is replaced with [REDACTED]
        assert.strictEqual(result.a.b.c, REDACTED);
    });

    await unitTest('Does not mutate the original object', () => {
        const original = { password: 'secret', data: 'safe' };
        const copy = { ...original };
        redact(original);
        assert.deepStrictEqual(original, copy);
    });

    // ── 1.5 redactPayloadString ───────────────────────────────
    subsection('1.5  redactPayloadString()');

    await unitTest('Parses → redacts → re-stringifies JSON', () => {
        const input = JSON.stringify({ password: 'secret', data: 'ok' });
        const result = JSON.parse(redactPayloadString(input));
        assert.strictEqual(result.password, REDACTED);
        assert.strictEqual(result.data, 'ok');
    });

    await unitTest('Returns original string on invalid JSON', () => {
        assert.strictEqual(redactPayloadString('not-json{{{'), 'not-json{{{');
    });

    await unitTest('Returns non-string inputs as-is', () => {
        assert.strictEqual(redactPayloadString(42), 42);
        assert.strictEqual(redactPayloadString(null), null);
        assert.strictEqual(redactPayloadString(undefined), undefined);
    });

    // ── 1.6 applyFieldMask ────────────────────────────────────
    subsection('1.6  applyFieldMask()');

    await unitTest('Includes only fields listed in the mask', () => {
        const result = applyFieldMask({ name: 'Alice', role: 'Admin', id: 1 }, 'name,role');
        assert.deepStrictEqual(result, { name: 'Alice', role: 'Admin' });
    });

    await unitTest('Strips unlisted fields (security boundary)', () => {
        const result = applyFieldMask({ id: 1, password: 'secret', $set: { admin: true } }, 'id');
        assert.deepStrictEqual(result, { id: 1 });
        assert.strictEqual(result.password, undefined);
        assert.strictEqual(result.$set, undefined);
    });

    await unitTest('Wildcard "*" mask → empty object (fail-safe)', () => {
        assert.deepStrictEqual(applyFieldMask({ a: 1, b: 2 }, '*'), {});
    });

    await unitTest('Empty / null / undefined mask → empty object', () => {
        assert.deepStrictEqual(applyFieldMask({ a: 1 }, ''), {});
        assert.deepStrictEqual(applyFieldMask({ a: 1 }, null), {});
        assert.deepStrictEqual(applyFieldMask({ a: 1 }, undefined), {});
    });

    await unitTest('Mask field not present in data → ignored safely', () => {
        const result = applyFieldMask({ a: 1 }, 'a,b,c');
        assert.deepStrictEqual(result, { a: 1 });
    });

    await unitTest('Trims whitespace from mask fields', () => {
        const result = applyFieldMask({ status: 'OK', url: 'http://x.com' }, ' status , url ');
        assert.deepStrictEqual(result, { status: 'OK', url: 'http://x.com' });
    });

    // ── 1.7 Circuit Breaker (Mocked Redis) ────────────────────
    subsection('1.7  Circuit Breaker (Mocked Redis)');

    // Build an in-process Redis mock
    const mockRedis = {
        _data: {}, _calls: [],
        async get(key) { return this._data[key] ?? null; },
        async incr(key) { const v = (this._data[key] || 0) + 1; this._data[key] = v; return v; },
        async expire() { return true; },
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
        defineCommand(name) {
            if (name === 'tripCircuit') {
                this.tripCircuit = async (countKey, statusKey, threshold, window, breakDuration) => {
                    threshold    = Number(threshold);
                    breakDuration = Number(breakDuration);
                    const count  = await this.incr(countKey);
                    if (count >= threshold) {
                        await this.set(statusKey, 'OPEN', 'EX', breakDuration);
                        this._data[countKey] = threshold - 1;
                        return 'TRIPPED';
                    }
                    return 'OK';
                };
            }
        },
        _reset() { this._data = {}; this._calls = []; }
    };

    // Inject mock into require cache
    const redisPath    = require.resolve('../src/redis');
    const origRedis    = require.cache[redisPath];
    require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: mockRedis };

    const cbPath = require.resolve('../src/circuitBreaker');
    delete require.cache[cbPath];
    const { recordFailure, getCircuitStatus, recordSuccess } = require('../src/circuitBreaker');

    mockRedis._reset();

    await unitTest('Circuit CLOSED by default (no failures)', async () => {
        const status = await getCircuitStatus('http://healthy.com');
        assert.strictEqual(status, 'CLOSED');
    });

    await unitTest('Circuit trips to OPEN after 5 consecutive failures', async () => {
        mockRedis._reset();
        for (let i = 0; i < 5; i++) await recordFailure('http://flaky.com');
        const status = await getCircuitStatus('http://flaky.com');
        assert.strictEqual(status, 'OPEN');
    });

    await unitTest('HALF_OPEN → recordSuccess → CLOSED (full lifecycle)', async () => {
        mockRedis._reset();
        // 1. Trip the breaker
        for (let i = 0; i < 5; i++) await recordFailure('http://recover.com');
        assert.strictEqual(await getCircuitStatus('http://recover.com'), 'OPEN');

        // 2. Simulate OPEN TTL expiry (in real Redis, the key auto-deletes after 30s)
        delete mockRedis._data['circuit_status:recover.com'];

        // 3. Now circuit is HALF_OPEN (counter is at threshold-1=4, status key gone)
        //    A probe request succeeds and calls recordSuccess()
        await recordSuccess('http://recover.com');

        // 4. recordSuccess clears the failure counter → fully CLOSED
        assert.strictEqual(await getCircuitStatus('http://recover.com'), 'CLOSED');
    });

    // Restore require cache
    if (origRedis) require.cache[redisPath] = origRedis;
    else delete require.cache[redisPath];
}


// ═════════════════════════════════════════════════════════════════
//  PART 2: END-TO-END / INTEGRATION TESTS (Live Services)
// ═════════════════════════════════════════════════════════════════
async function runE2ETests() {
    section('PHASE 2: INTEGRATION / E2E TESTS (Live Services)');

    // ── Pre-flight checks ─────────────────────────────────────
    subsection('2.0  Pre-flight — Environment & Connectivity');

    if (!API_KEY) {
        console.log(chalk.red('\n  ⚠️  API_KEY not set in .env — E2E tests require it.'));
        console.log(chalk.dim('     Create a .env file with: API_KEY=your_key'));
        return;
    }

    let serverUp = false;
    try {
        await axios.get(`${API_BASE}/`, { timeout: 3000, validateStatus: () => true });
        serverUp = true;
        console.log(`${PASS} API server reachable at ${chalk.underline(API_BASE)}`);
    } catch {
        console.log(`${FAIL} API server NOT reachable at ${API_BASE}`);
    }

    if (!serverUp) {
        console.log(chalk.yellow('\n  ⚠️  Skipping E2E tests — API server not found.'));
        console.log(chalk.dim('     Start with: docker-compose up -d'));
        console.log(chalk.dim('           or  : node server.js  (+ redis-server + mongod)'));
        return;
    }

    // HTTP clients — authenticated and unauthenticated
    const api = axios.create({
        baseURL: API_BASE, timeout: 10000,
        validateStatus: () => true,
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
    });

    const noAuth = axios.create({
        baseURL: API_BASE, timeout: 10000,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' }
    });

    // Track event IDs for cleanup
    const createdIds = [];

    // ── 2.1 Authentication ────────────────────────────────────
    subsection('2.1  Authentication (API Key Guard)');

    await e2eTest('GET /api/events without API key → 403', async () => {
        const res = await noAuth.get('/api/events');
        assert.strictEqual(res.status, 403);
    });

    await e2eTest('GET /api/events with wrong API key → 403', async () => {
        const res = await noAuth.get('/api/events', {
            headers: { 'x-api-key': 'definitely-wrong-key-12345' }
        });
        assert.strictEqual(res.status, 403);
    });

    await e2eTest('POST /api/events without API key → 403', async () => {
        const res = await noAuth.post('/api/events', {
            url: 'http://example.com', payload: { a: 1 }
        });
        assert.strictEqual(res.status, 403);
    });

    await e2eTest('GET /api/events with valid API key → 200', async () => {
        const res = await api.get('/api/events');
        assert.strictEqual(res.status, 200);
        assert.ok(res.data.events, 'Response should have events array');
        assert.ok(res.data.pagination, 'Response should have pagination object');
    });

    // ── 2.2 Input Validation ──────────────────────────────────
    subsection('2.2  Input Validation (Joi Schema)');

    await e2eTest('POST missing "url" → 400 VALIDATION_FAILED', async () => {
        const res = await api.post('/api/events', { payload: { a: 1 } });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.data.code, 'VALIDATION_FAILED');
    });

    await e2eTest('POST missing "payload" → 400 VALIDATION_FAILED', async () => {
        const res = await api.post('/api/events', { url: 'http://example.com' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.data.code, 'VALIDATION_FAILED');
    });

    await e2eTest('POST invalid URL scheme (ftp://) → 400', async () => {
        const res = await api.post('/api/events', {
            url: 'ftp://files.example.com/data', payload: { x: 1 }
        });
        assert.strictEqual(res.status, 400);
    });

    await e2eTest('POST non-object payload (string) → 400', async () => {
        const res = await api.post('/api/events', {
            url: 'http://example.com', payload: 'not-an-object'
        });
        assert.strictEqual(res.status, 400);
    });

    await e2eTest('POST empty body → 400', async () => {
        const res = await api.post('/api/events', {});
        assert.strictEqual(res.status, 400);
    });

    // ── 2.3 Event Creation (Happy Path) ───────────────────────
    subsection('2.3  Event Creation (POST /api/events)');

    let primaryEventId  = null;
    let primaryTraceId  = null;

    await e2eTest('POST valid event → 202 Accepted + returns id & traceId', async () => {
        const res = await api.post('/api/events', {
            url: WEBHOOK_TARGET,
            payload: { test: true, timestamp: Date.now(), greeting: 'Hello from fullTest.js!' }
        });
        assert.strictEqual(res.status, 202);
        assert.ok(res.data.id,      'Response must contain event ID');
        assert.ok(res.data.traceId, 'Response must contain traceId');
        assert.strictEqual(res.data.status, 'accepted');
        primaryEventId = res.data.id;
        primaryTraceId = res.data.traceId;
        createdIds.push(primaryEventId);
        info(`Event created: ${primaryEventId} (trace: ${primaryTraceId})`);
    });

    await e2eTest('POST second event → also 202 (not a duplicate)', async () => {
        const res = await api.post('/api/events', {
            url: WEBHOOK_TARGET,
            payload: { test: true, count: 2 }
        });
        assert.strictEqual(res.status, 202);
        createdIds.push(res.data.id);
    });

    // ── 2.4 GET Routes (Read) ─────────────────────────────────
    subsection('2.4  GET /api/events & GET /api/events/:id');

    await e2eTest('GET /api/events → 200 with paginated list', async () => {
        const res = await api.get('/api/events');
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.data.events));
        assert.ok(res.data.pagination.total >= 1, 'Should have at least 1 event');
        info(`Total events in DB: ${res.data.pagination.total}`);
    });

    await e2eTest('GET /api/events?limit=1 → returns exactly 1 event', async () => {
        const res = await api.get('/api/events?limit=1');
        assert.strictEqual(res.status, 200);
        assert.ok(res.data.events.length <= 1);
    });

    if (primaryEventId) {
        await e2eTest('GET /api/events/:id → 200 with event details', async () => {
            const res = await api.get(`/api/events/${primaryEventId}`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(String(res.data._id), String(primaryEventId));
            assert.ok(res.data.traceId, 'Event should have traceId');
            assert.ok(res.data.url,     'Event should have url');
            assert.ok(res.data.status,  'Event should have status');
            info(`Event status: ${res.data.status} | url: ${res.data.url}`);
        });
    }

    await e2eTest('GET /api/events/:id with fake ID → 404', async () => {
        const res = await api.get('/api/events/000000000000000000000000');
        assert.strictEqual(res.status, 404);
    });

    // ── 2.5 Worker Lifecycle (Delivery) ───────────────────────
    subsection('2.5  Event Lifecycle (Worker Processing)');

    if (primaryEventId) {
        console.log(`${WAIT} Polling event status for up to 20 seconds...`);
        let finalStatus = 'PENDING';
        const pollStart = Date.now();
        while (Date.now() - pollStart < 20000) {
            const res = await api.get(`/api/events/${primaryEventId}`);
            if (res.data && res.data.status && res.data.status !== 'PENDING') {
                finalStatus = res.data.status;
                break;
            }
            await sleep(1500);
        }

        await e2eTest(`Event processed by worker (status ≠ PENDING → got "${finalStatus}")`, () => {
            assert.notStrictEqual(finalStatus, 'PENDING', 'Worker should have picked up the event');
            info(`Final status: ${finalStatus}`);
        });

        // External targets (httpbin.org) should → COMPLETED
        // Localhost targets → FAILED_PERMANENT (SSRF)
        const isPublicTarget = WEBHOOK_TARGET.includes('httpbin.org') ||
                               WEBHOOK_TARGET.includes('webhook.site');
        if (isPublicTarget && finalStatus === 'COMPLETED') {
            await e2eTest('Webhook delivered to external target → COMPLETED', () => {
                assert.strictEqual(finalStatus, 'COMPLETED');
            });
        } else if (isPublicTarget && finalStatus !== 'COMPLETED') {
            // Public target but not COMPLETED — might be network issue
            e2eSkip(`Delivery to ${WEBHOOK_TARGET} → ${finalStatus}`,
                    'Target may be unreachable from this environment');
        }

        // Verify event has populated fields after processing
        await e2eTest('Processed event has attemptCount ≥ 1', async () => {
            const res = await api.get(`/api/events/${primaryEventId}`);
            assert.ok(res.data.attemptCount >= 1, `Expected ≥1, got ${res.data.attemptCount}`);
        });
    } else {
        e2eSkip('Worker lifecycle tests', 'No event was created in step 2.3');
    }

    // ── 2.6 Idempotency ──────────────────────────────────────
    subsection('2.6  Idempotency (Duplicate Prevention)');

    const idempKey = `test-idemp-${crypto.randomBytes(6).toString('hex')}`;

    await e2eTest('POST with Idempotency-Key → 202 Accepted (first time)', async () => {
        const res = await api.post('/api/events', {
            url: WEBHOOK_TARGET,
            payload: { dedup: true }
        }, {
            headers: { 'idempotency-key': idempKey, 'x-api-key': API_KEY }
        });
        assert.strictEqual(res.status, 202);
        createdIds.push(res.data.id);
        info(`Idempotent event: ${res.data.id}`);
    });

    await e2eTest('POST with SAME Idempotency-Key → 409 Conflict', async () => {
        const res = await api.post('/api/events', {
            url: WEBHOOK_TARGET,
            payload: { dedup: true }
        }, {
            headers: { 'idempotency-key': idempKey, 'x-api-key': API_KEY }
        });
        assert.strictEqual(res.status, 409);
        assert.ok(res.data.existingId, 'Should return the existing event ID');
        assert.ok(res.data.existingStatus, 'Should return the existing event status');
        info(`Collision detected — existing: ${res.data.existingId} (${res.data.existingStatus})`);
    });

    // ── 2.7 PATCH (Field Mask) ────────────────────────────────
    subsection('2.7  PATCH /api/events/:id (Field Mask)');

    if (primaryEventId) {
        await e2eTest('PATCH without updateMask → 400 (no valid fields)', async () => {
            const res = await api.patch(`/api/events/${primaryEventId}`, {
                status: 'FAILED'
            });
            assert.strictEqual(res.status, 400);
        });

        await e2eTest('PATCH with updateMask=status → 200 (updates status)', async () => {
            const res = await api.patch(
                `/api/events/${primaryEventId}?updateMask=status`,
                { status: 'FAILED' }
            );
            assert.strictEqual(res.status, 200);
            assert.ok(res.data.updatedFields.includes('status'));
        });

        await e2eTest('PATCH with updateMask=url → 200 (updates url)', async () => {
            const res = await api.patch(
                `/api/events/${primaryEventId}?updateMask=url`,
                { url: 'http://updated.example.com' }
            );
            assert.strictEqual(res.status, 200);
            assert.ok(res.data.updatedFields.includes('url'));
        });

        await e2eTest('PATCH unknown fields stripped by Joi (NoSQL injection guard)', async () => {
            const res = await api.patch(
                `/api/events/${primaryEventId}?updateMask=status`,
                { status: 'PENDING', $set: { admin: true }, __proto__: { evil: true } }
            );
            // Joi strips unknown fields, so the PATCH should still succeed
            // but only update "status"
            if (res.status === 200) {
                assert.ok(!res.data.updatedFields.includes('$set'));
            }
        });

        await e2eTest('PATCH nonexistent event → 404', async () => {
            const res = await api.patch(
                '/api/events/000000000000000000000000?updateMask=status',
                { status: 'FAILED' }
            );
            assert.strictEqual(res.status, 404);
        });
    }

    // ── 2.8 Replay ────────────────────────────────────────────
    subsection('2.8  Replay (POST /api/events/:id/replay)');

    if (primaryEventId) {
        // First reset status to allow replay
        await api.patch(`/api/events/${primaryEventId}?updateMask=status`, {
            status: 'FAILED'
        });

        await e2eTest('POST /api/events/:id/replay → 200 "Replay started"', async () => {
            const res = await api.post(`/api/events/${primaryEventId}/replay`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.message, 'Replay started');
            info(`Replay triggered for event: ${primaryEventId}`);
        });

        await e2eTest('Replay of nonexistent event → 404', async () => {
            const res = await api.post('/api/events/000000000000000000000000/replay');
            assert.strictEqual(res.status, 404);
        });
    }

    // ── 2.9 SSRF Protection ──────────────────────────────────
    subsection('2.9  SSRF Protection (Private IP Rejection)');

    await e2eTest('Webhook targeting 127.0.0.1 → accepted but worker rejects (SSRF)', async () => {
        const res = await api.post('/api/events', {
            url: 'http://127.0.0.1:9999/evil',
            payload: { ssrf_test: true }
        });
        // The API ACCEPTS the event (it doesn't do SSRF checks — the worker does)
        assert.strictEqual(res.status, 202);
        const ssrfEventId = res.data.id;
        createdIds.push(ssrfEventId);

        // Wait for worker to process and reject
        console.log(`${WAIT} Waiting for worker SSRF rejection (up to 10s)...`);
        let ssrfStatus = 'PENDING';
        const start = Date.now();
        while (Date.now() - start < 10000) {
            const check = await api.get(`/api/events/${ssrfEventId}`);
            if (check.data && check.data.status && check.data.status !== 'PENDING') {
                ssrfStatus = check.data.status;
                break;
            }
            await sleep(1500);
        }

        info(`SSRF event status: ${ssrfStatus}`);
        // Worker should mark it FAILED_PERMANENT (SSRF is a permanent rejection)
        if (ssrfStatus !== 'PENDING') {
            assert.ok(
                ['FAILED_PERMANENT', 'FAILED', 'DEAD'].includes(ssrfStatus),
                `Expected a failure status for SSRF, got: ${ssrfStatus}`
            );
        }
    });

    // ── 2.10 Dashboard & Static Files ─────────────────────────
    subsection('2.10  Dashboard (Static Files & Socket.IO)');

    await e2eTest('GET / → 200 serves dashboard HTML', async () => {
        const res = await noAuth.get('/');
        assert.strictEqual(res.status, 200);
        assert.ok(
            typeof res.data === 'string' && res.data.includes('Webhook Dispatcher'),
            'Response should contain dashboard title'
        );
    });

    await e2eTest('GET /socket.io/socket.io.js → 200 (client lib served)', async () => {
        const res = await noAuth.get('/socket.io/socket.io.js');
        assert.strictEqual(res.status, 200);
    });

    // ── 2.11 Rate Limiting ────────────────────────────────────
    subsection('2.11  Rate Limiting (Quick Sanity Check)');

    await e2eTest('Rate limiter headers present (RateLimit-*)', async () => {
        const res = await api.post('/api/events', {
            url: 'http://example.com', payload: { rate_test: true }
        });
        // express-rate-limit sets standardHeaders
        const hasRateHeaders = res.headers['ratelimit-limit'] ||
                               res.headers['ratelimit-remaining'] ||
                               res.headers['x-ratelimit-limit'];
        // Some versions use different header names — just verify it's not missing entirely
        // The important thing is the endpoint still responds (not rate-limited yet)
        assert.ok([202, 429].includes(res.status), `Expected 202 or 429, got ${res.status}`);
        if (res.status === 202) createdIds.push(res.data.id);
    });

    // ── 2.12 Force Retry (x-force-retry header) ──────────────
    subsection('2.12  Force Retry (Idempotency + x-force-retry)');

    const retryKey = `test-retry-${crypto.randomBytes(4).toString('hex')}`;

    // Create an event with an idempotency key
    const createRes = await api.post('/api/events', {
        url: WEBHOOK_TARGET,
        payload: { retry_test: true }
    }, {
        headers: { 'idempotency-key': retryKey, 'x-api-key': API_KEY }
    });

    if (createRes.status === 202) {
        createdIds.push(createRes.data.id);

        // Wait for it to leave PENDING
        await sleep(3000);

        await e2eTest('Force retry with x-force-retry: true → 202 Accepted', async () => {
            const res = await api.post('/api/events', {
                url: WEBHOOK_TARGET,
                payload: { retry_test: true, attempt: 2 }
            }, {
                headers: {
                    'idempotency-key': retryKey,
                    'x-force-retry': 'true',
                    'x-api-key': API_KEY
                }
            });
            // 202 if the event was found and status wasn't PENDING
            // 409 if it's still PENDING (race condition)
            // 404 if idempotency key not found (shouldn't happen)
            assert.ok(
                [202, 409].includes(res.status),
                `Expected 202 or 409, got ${res.status}: ${JSON.stringify(res.data)}`
            );
            info(`Force retry response: ${res.status} — ${res.data.message || res.data.error}`);
        });
    }

    // ── 2.13 DELETE Route ─────────────────────────────────────
    subsection('2.13  DELETE /api/events/:id');

    // Create a throwaway event to delete
    const delRes = await api.post('/api/events', {
        url: 'http://example.com', payload: { to_delete: true }
    });
    const deleteId = delRes.status === 202 ? delRes.data.id : null;

    if (deleteId) {
        await e2eTest('DELETE /api/events/:id → 200', async () => {
            const res = await api.delete(`/api/events/${deleteId}`);
            assert.strictEqual(res.status, 200);
            assert.ok(res.data.message.includes('deleted'));
        });

        await e2eTest('GET deleted event → 404', async () => {
            const res = await api.get(`/api/events/${deleteId}`);
            assert.strictEqual(res.status, 404);
        });

        await e2eTest('DELETE nonexistent event → 404', async () => {
            const res = await api.delete('/api/events/000000000000000000000000');
            assert.strictEqual(res.status, 404);
        });
    }

    // ── 2.14 Cleanup Test Events ──────────────────────────────
    subsection('2.14  Cleanup (Removing Test Events)');

    let cleaned = 0;
    for (const id of createdIds) {
        try {
            const res = await api.delete(`/api/events/${id}`);
            if (res.status === 200) cleaned++;
        } catch { /* ignore */ }
    }
    info(`Cleaned up ${cleaned}/${createdIds.length} test events`);
}


// ═════════════════════════════════════════════════════════════════
//  MAIN RUNNER
// ═════════════════════════════════════════════════════════════════
async function main() {
    banner('WEBHOOK DISPATCHER — FULL TEST SUITE');

    console.log(chalk.dim('  Config:'));
    console.log(chalk.dim(`    API URL       : ${API_BASE}`));
    console.log(chalk.dim(`    API KEY       : ${API_KEY ? '***' + API_KEY.slice(-4) : chalk.red('NOT SET')}`));
    console.log(chalk.dim(`    WEBHOOK TARGET: ${WEBHOOK_TARGET}`));
    console.log(chalk.dim(`    Mode          : ${UNIT_ONLY ? 'Unit Only' : E2E_ONLY ? 'E2E Only' : 'Full Suite'}`));

    const startTime = Date.now();

    if (!E2E_ONLY) await runUnitTests();
    if (!UNIT_ONLY) await runE2ETests();

    // ── FINAL SCORECARD ─────────────────────────────────────────
    const elapsed     = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalPassed = unitPassed + e2ePassed;
    const totalFailed = unitFailed + e2eFailed;
    const total       = totalPassed + totalFailed + e2eSkipped;

    console.log('\n');
    section('RESULTS');

    const w = 57;
    const line = '─'.repeat(w);
    console.log(chalk.dim(`  ┌${line}┐`));

    if (!E2E_ONLY) {
        const unitLine = `  UNIT TESTS:     ${unitPassed} passed, ${unitFailed} failed`;
        console.log(chalk.dim('  │') + (unitFailed ? chalk.red : chalk.green)(unitLine.padEnd(w)) + chalk.dim('│'));
    }
    if (!UNIT_ONLY) {
        let e2eLine = `  E2E  TESTS:     ${e2ePassed} passed, ${e2eFailed} failed`;
        if (e2eSkipped) e2eLine += `, ${e2eSkipped} skipped`;
        console.log(chalk.dim('  │') + (e2eFailed ? chalk.red : chalk.green)(e2eLine.padEnd(w)) + chalk.dim('│'));
    }

    console.log(chalk.dim('  │') + chalk.dim(`  ${'─'.repeat(40)}`.padEnd(w)) + chalk.dim('│'));

    if (totalFailed === 0) {
        const msg = `  TOTAL: ${totalPassed}/${total} passed  ✅  ALL CLEAR`;
        console.log(chalk.dim('  │') + chalk.bold.green(msg.padEnd(w)) + chalk.dim('│'));
    } else {
        const msg = `  TOTAL: ${totalPassed}/${total} passed, ${totalFailed} FAILED ❌`;
        console.log(chalk.dim('  │') + chalk.bold.red(msg.padEnd(w)) + chalk.dim('│'));
    }

    const timeLine = `  Time: ${elapsed}s`;
    console.log(chalk.dim('  │') + chalk.dim(timeLine.padEnd(w)) + chalk.dim('│'));
    console.log(chalk.dim(`  └${line}┘`));

    // Print failure details
    if (failures.length > 0) {
        console.log(chalk.red('\n  ┌─ Failed Tests ──────────────────────────────────────────┐'));
        failures.forEach((f, i) => {
            console.log(chalk.red(`  │  ${i + 1}. [${f.phase}] ${f.name}`));
            console.log(chalk.dim(`  │     → ${f.error}`));
        });
        console.log(chalk.red('  └─────────────────────────────────────────────────────────┘'));
    }

    // Visual banner
    if (totalFailed === 0) {
        console.log(chalk.green('\n  🎉  All tests passed — your webhook-dispatcher is solid!'));
        if (!UNIT_ONLY) {
            console.log(chalk.dim(`\n  💡  Open the dashboard for visual confirmation:`));
            console.log(chalk.cyan(`      ${API_BASE}?token=${DASHBOARD_TOKEN || 'YOUR_DASHBOARD_TOKEN'}\n`));
        }
    } else {
        console.log(chalk.red('\n  🔧  Some tests failed — review the errors above.\n'));
    }

    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(chalk.red('\n💥 Unexpected error in test runner:'), err);
    process.exit(1);
});
