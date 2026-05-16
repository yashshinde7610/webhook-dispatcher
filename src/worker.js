// src/worker.js
require('dotenv').config();

// Fail fast if WEBHOOK_SECRET isn't set — we need it for every job
const REQUIRED_ENV = ['WEBHOOK_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const axios = require('axios');
const logger = require('./utils/logger');
const { redactPayloadString } = require('./utils/redact');

const redis = require('./redis');
const Event = require('./models/Event');

// BullMQ needs its own connection — blocking commands would deadlock the shared one
const bullmqConnectionOptions = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379
};

const { getCircuitStatus, recordFailure, recordSuccess } = require('./circuitBreaker');
const { persistState } = require('./batchProcessor');

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { safeHttpStatus, createHmacSignature, classifyError } = require('./utils/workerUtils');

// ── SSRF Protection ──────────────────────────────────────────
// We can't just regex the hostname — things like 127.0.0.1.nip.io,
// octal IPs (0177.0.0.1), or DNS rebinding would bypass it.
// Instead: resolve via DNS, then check the actual IP against
// known private ranges.

function isPrivateIP(ip) {
    // Handle IPv4-mapped IPv6 like ::ffff:10.0.0.1
    if (ip.startsWith('::ffff:')) {
        ip = ip.slice(7);
    }

    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        const [a, b] = parts;

        if (a === 0)   return true;                          // current network
        if (a === 10)  return true;                          // RFC-1918
        if (a === 127) return true;                          // loopback
        if (a === 169 && b === 254) return true;             // link-local
        if (a === 172 && b >= 16 && b <= 31) return true;    // RFC-1918
        if (a === 192 && b === 168) return true;             // RFC-1918
        if (a === 100 && b >= 64 && b <= 127) return true;   // CGN / shared
        if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking

        return false;
    }

    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1') return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        if (normalized.startsWith('fe80')) return true;
        return false;
    }

    // Unknown format — block it (fail-closed)
    return true;
}

/**
 * Resolve hostname via DNS and reject if the IP is private.
 * Returns the validated IP so we can pin Axios to it.
 */
async function assertNotPrivate(hostname) {
    if (net.isIP(hostname)) {
        if (isPrivateIP(hostname)) {
            throw Object.assign(
                new Error(`SSRF Blocked: Target resolves to private IP: ${hostname}`),
                { ssrfBlocked: true }
            );
        }
        return hostname;
    }

    const { address } = await dns.promises.lookup(hostname);

    if (isPrivateIP(address)) {
        throw Object.assign(
            new Error(`SSRF Blocked: ${hostname} resolved to private IP ${address}`),
            { ssrfBlocked: true }
        );
    }

    return address;
}

// ── MongoDB connection ───────────────────────────────────────
const MONGO_POOL_SIZE = Number(process.env.MONGO_POOL_SIZE) || 55;
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db', {
    maxPoolSize: MONGO_POOL_SIZE,
})
    .then(() => logger.info({ poolSize: MONGO_POOL_SIZE }, 'Worker connected to MongoDB'))
    .catch(err => logger.error({ err }, 'MongoDB connection error'));

// ── Job processor ────────────────────────────────────────────
const worker = new Worker('webhook-queue', async (job) => {
    const { url, payload: rawPayload, dbId, traceId, deliverySemantics } = job.data;
    const tid = traceId || 'NO-TRACE-ID';
    const currentAttempt = job.attemptsMade + 1;

    // Legacy jobs might have payload as Object instead of String
    const payloadString = typeof rawPayload === 'string'
        ? rawPayload
        : JSON.stringify(rawPayload);

    if (deliverySemantics !== 'AT_LEAST_ONCE_UNORDERED') {
        logger.warn({ traceId: tid, deliverySemantics }, 'Unknown delivery semantics');
    }

    // We skip the PROCESSING write here — BullMQ already tracks in-flight
    // state in Redis. Writing to Mongo only on final resolution cuts
    // per-job writes from 3-4 down to 1.

    if (process.env.NODE_ENV !== 'production') {
        logger.debug({ traceId: tid, dbId, payload: redactPayloadString(payloadString) }, 'Worker picked up job');
    }
    try {
        // Circuit breaker check
        const circuitState = await getCircuitStatus(url);
        if (circuitState === 'OPEN' || circuitState === 'HALF_OPEN_BLOCKED') {
            throw new Error('Circuit Breaker Open');
        }

        // SSRF check: resolve hostname, validate IP, get the actual address
        const target = new URL(url);
        const validatedIP = await assertNotPrivate(target.hostname);

        // Sign the raw payload string (not parsed object) so the receiver
        // can verify against the exact bytes on the wire
        const signature = createHmacSignature(payloadString, process.env.WEBHOOK_SECRET);

        // Pin Axios to the IP we already validated. Without this, Axios
        // would do its own DNS lookup which could resolve to a different
        // IP (classic TOCTOU / DNS rebinding attack).
        const pinnedLookup = (_hostname, _opts, cb) => {
            if (typeof _opts === 'function') { cb = _opts; }
            cb(null, validatedIP, net.isIPv4(validatedIP) ? 4 : 6);
        };

        // AbortController for a hard 5s wall-clock timeout. Axios' built-in
        // timeout only measures idle time between chunks, so a tarpit server
        // trickling 1 byte/min would keep the connection alive forever.
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 5000);

        // Per-request agents with DNS pinning. We set keepAlive: false and
        // destroy them in the finally block to prevent leaked TCP pools.
        const pinnedHttpAgent  = new http.Agent({ lookup: pinnedLookup, keepAlive: false });
        const pinnedHttpsAgent = new https.Agent({ lookup: pinnedLookup, keepAlive: false });

        let response;
        try {
            response = await axios.post(url, payloadString, {
                headers: {
                    'X-Signature': signature,
                    'X-Webhook-Trace-Id': tid,
                    'Content-Type': 'application/json'
                },
                // Prevent Axios from re-serializing the string (would break HMAC)
                transformRequest: [data => data],
                timeout: 5000,
                signal: controller.signal,
                httpAgent:  pinnedHttpAgent,
                httpsAgent: pinnedHttpsAgent,
                maxContentLength:  1 * 1024 * 1024,
                maxBodyLength:     1 * 1024 * 1024,
                maxRedirects:      0,
            });
        } finally {
            clearTimeout(abortTimer);
            pinnedHttpAgent.destroy();
            pinnedHttpsAgent.destroy();
        }

        // Success path
        await recordSuccess(url);
        if (process.env.NODE_ENV !== 'production') {
            logger.info({ traceId: tid, status: response.status }, 'Webhook delivered');
        }

        if (dbId) {
            await persistState({
                dbId,
                status: 'COMPLETED',
                httpStatus: safeHttpStatus(response.status),
                incrementAttempt: true,
                logEntry: {
                    attempt: currentAttempt,
                    status: safeHttpStatus(response.status),
                    response: 'Success'
                }
            });
        }

        return response.data;

    } catch (error) {
        // SSRF is permanent — never retry sending to a private IP
        if (error.ssrfBlocked) {
            logger.error({ traceId: tid, err: error.message }, 'SSRF BLOCKED');
            if (dbId) {
                await persistState({
                    dbId,
                    status: 'FAILED_PERMANENT',
                    failureType: 'PERMANENT',
                    lastError: error.message,
                    incrementAttempt: true,
                    logEntry: { attempt: currentAttempt, status: null, response: error.message }
                });
            }
            return { status: 'aborted', reason: 'SSRF Blocked' };
        }

        const type = classifyError(error);
        const msg = error.message || String(error);
        const httpStatus = safeHttpStatus(error.response?.status);
        const errorCode = error.code ? String(error.code) : null;

        if (msg !== 'Circuit Breaker Open' && type === 'TRANSIENT') {
            await recordFailure(url);
        }

        logger.warn({ traceId: tid, failureType: type, err: msg }, 'Job failed');

        if (dbId) {
            const maxAttempts = job.opts.attempts || 5;
            const isFinalAttempt = currentAttempt >= maxAttempts;

            await persistState({
                dbId,
                status: isFinalAttempt ? 'DEAD'
                    : (type === 'PERMANENT') ? 'FAILED_PERMANENT'
                    : 'FAILED',
                failureType: (type === 'PERMANENT' || isFinalAttempt) ? 'PERMANENT' : 'TRANSIENT',
                httpStatus,
                errorCode,
                lastError: isFinalAttempt ? `Max Retries Reached: ${msg}` : msg,
                incrementAttempt: true,
                logEntry: { attempt: currentAttempt, status: httpStatus, response: msg }
            });

            if (isFinalAttempt) {
                logger.error({ traceId: tid, dbId, attempt: currentAttempt }, 'Job DEAD (max retries)');
                return { status: 'dead', reason: 'Max Retries Reached' };
            }
        }

        if (type === 'PERMANENT') {
            return { status: 'aborted', reason: 'Permanent Failure' };
        }

        throw error; // triggers BullMQ retry
    }
}, {
    connection: bullmqConnectionOptions,
    concurrency: 50,
    limiter: { max: 50, duration: 1000 }
});

// Safety net: if the processor somehow doesn't mark a job as DEAD,
// this listener catches it. Idempotent — setting DEAD twice is a no-op.
worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= job.opts.attempts) {
        logger.warn({ traceId: job.data.traceId, jobId: job.id }, 'Death listener safety net fired');
        if (job.data.dbId) {
            await Event.findByIdAndUpdate(job.data.dbId, {
                status: 'DEAD',
                failureType: 'PERMANENT',
                lastError: `Max Retries Reached: ${err.message}`
            });
        }
    }
});

logger.info({ concurrency: 50, limiter: '50/s' }, 'Background worker active');

// ── Graceful shutdown ────────────────────────────────────────
const SHUTDOWN_TIMEOUT_MS = 15_000;

let shutdownInProgress = false;
async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    // Force-exit if draining takes too long (tarpit protection)
    const forceTimer = setTimeout(() => {
        logger.error('Forced shutdown after drain timeout (15 s)');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
        logger.info('Closing BullMQ Worker (draining in-flight jobs)...');
        await worker.close();

        logger.info('Closing MongoDB Connection...');
        await mongoose.connection.close();

        logger.info('Closing Redis Connection...');
        await redis.quit();

        logger.info('Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'UNCAUGHT EXCEPTION');
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'UNHANDLED REJECTION');
    gracefulShutdown('unhandledRejection');
});
