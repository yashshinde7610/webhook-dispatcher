// src/worker.js
require('dotenv').config();

// --- 🛡️ FAIL-FAST ENV VALIDATION ---
// Crash at boot — not after the first job tries to sign a payload.
// WEBHOOK_SECRET is used by createHmacSignature() on every single job.
// API_KEY is optional here (only the API server needs it), but
// WEBHOOK_SECRET is non-negotiable for the worker.
const REQUIRED_ENV = ['WEBHOOK_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Set them in .env or your deployment config before starting the worker.');
    process.exit(1);
}

const { Worker } = require('bullmq'); 
const mongoose = require('mongoose');
const axios = require('axios');
const logger = require('./utils/logger');
const { redactPayloadString } = require('./utils/redact');

// Infrastructure
const redis = require('./redis'); // App-level Redis (circuit breaker, DLQ, etc.)
const Event = require('./models/Event');

// 🛡️ DEDICATED CONNECTION: BullMQ must NOT share the app Redis instance.
// BullMQ workers use blocking Redis commands that would deadlock non-blocking ops.
const bullmqConnectionOptions = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379
}; 

// Services & Utils
const { getCircuitStatus, recordFailure, recordSuccess } = require('./circuitBreaker');
const { persistState } = require('./batchProcessor');

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { safeHttpStatus, createHmacSignature, classifyError } = require('./utils/workerUtils');

// --- 🛡️ SSRF PROTECTION (DNS-Resolution Based) ---
//
// WHY NOT A REGEX?
//   A regex on the raw hostname is trivially bypassed:
//     • DNS aliases:      http://127.0.0.1.nip.io  → resolves to 127.0.0.1
//     • Octal encoding:   http://0177.0.0.1        → 127.0.0.1
//     • Decimal encoding:  http://2130706433        → 127.0.0.1
//     • IPv6 shorthand:   http://[::ffff:127.0.0.1]
//     • DNS rebinding:    first lookup = public IP, second = 127.0.0.1
//
// THE FIX:
//   1. Resolve the hostname through the OS DNS resolver.
//   2. Check the **resolved IP** against RFC-1918 / RFC-5735 / RFC-4193 ranges.
//   This makes the bypass surface the DNS resolver itself, not our string checks.

/**
 * Returns true if the given IP (v4 or v6) belongs to a private, loopback,
 * link-local, or otherwise non-routable address range.
 */
function isPrivateIP(ip) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) — extract the v4 portion
    if (ip.startsWith('::ffff:')) {
        ip = ip.slice(7);
    }

    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        const [a, b] = parts;

        if (a === 0)   return true;                          // 0.0.0.0/8   (current network)
        if (a === 10)  return true;                          // 10.0.0.0/8  (RFC-1918)
        if (a === 127) return true;                          // 127.0.0.0/8 (loopback)
        if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
        if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 (RFC-1918)
        if (a === 192 && b === 168) return true;             // 192.168.0.0/16 (RFC-1918)
        if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGN / shared)
        if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)

        return false;
    }

    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1') return true;                // IPv6 loopback
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA (RFC-4193)
        if (normalized.startsWith('fe80')) return true;       // Link-local

        return false;
    }

    // Unrecognized format — block by default (fail-closed)
    return true;
}

/**
 * Resolve a hostname and reject it if the resulting IP is private.
 * Throws with { ssrfBlocked: true } on violation.
 */
async function assertNotPrivate(hostname) {
    // If the hostname is already a raw IP literal, check it directly
    if (net.isIP(hostname)) {
        if (isPrivateIP(hostname)) {
            throw Object.assign(
                new Error(`SSRF Blocked: Target resolves to private IP: ${hostname}`),
                { ssrfBlocked: true }
            );
        }
        return hostname; // Already validated, return as-is
    }

    // Resolve through OS DNS (respects /etc/hosts, systemd-resolved, etc.)
    const { address } = await dns.promises.lookup(hostname);

    if (isPrivateIP(address)) {
        throw Object.assign(
            new Error(`SSRF Blocked: ${hostname} resolved to private IP ${address}`),
            { ssrfBlocked: true }
        );
    }

    return address; // Return the validated IP for pinning
}

// --- 🔌 CONNECT MONGO ---
// 🛡️ BOUNDED CONNECTION POOL: Without an explicit cap, Mongoose defaults to
// 100 connections.  At 20 horizontal replicas that's 2,000 connections —
// enough to exhaust most managed MongoDB tiers.  Cap at concurrency + overhead.
const MONGO_POOL_SIZE = Number(process.env.MONGO_POOL_SIZE) || 55; // 50 concurrency + 5 overhead
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db', {
    maxPoolSize: MONGO_POOL_SIZE,
})
    .then(() => logger.info({ poolSize: MONGO_POOL_SIZE }, 'Worker connected to MongoDB'))
    .catch(err => logger.error({ err }, 'MongoDB connection error'));

// --- 👷 WORKER PROCESSOR ---
const worker = new Worker('webhook-queue', async (job) => {
    const { url, payload: rawPayload, dbId, traceId, deliverySemantics } = job.data;
    const tid = traceId || 'NO-TRACE-ID'; 
    const currentAttempt = job.attemptsMade + 1;

    // 🛡️ PAYLOAD FORMAT GUARD: payload is stored as a JSON string in MongoDB
    // since session 4.  Older jobs (pre-migration) may still carry an Object.
    const payloadString = typeof rawPayload === 'string'
        ? rawPayload
        : JSON.stringify(rawPayload);

    // 1. Validate Delivery Semantics
    if (deliverySemantics !== 'AT_LEAST_ONCE_UNORDERED') {
        logger.warn({ traceId: tid, deliverySemantics }, 'Unknown delivery semantics');
    }

    // NOTE: PROCESSING write removed (Fix 3 — Write Amplification).
    // The Event document is already created in server.js at ingestion time
    // (status: PENDING).  BullMQ tracks the in-flight state in Redis.
    // We only write to MongoDB on final resolution (COMPLETED/FAILED/DEAD),
    // cutting per-job MongoDB writes from 3–4 down to 1.

    if (process.env.NODE_ENV !== 'production') {
        logger.debug({ traceId: tid, dbId, payload: redactPayloadString(payloadString) }, 'Worker picked up job');
    }
    try {
        // 4. Circuit Breaker Check
        const circuitState = await getCircuitStatus(url);
        if (circuitState === 'OPEN' || circuitState === 'HALF_OPEN_BLOCKED') {
            throw new Error('Circuit Breaker Open');
        }
        // circuitState === 'HALF_OPEN_PROBE' → this worker won the probe lock;
        // it will send the request normally.  On success, recordSuccess() closes
        // the circuit.  On failure, recordFailure() will re-trip it.

        // 5. SSRF Guard: Resolve hostname via DNS, then check the resolved IP.
        //    Defeats nip.io aliases, octal/hex encoding, DNS rebinding, etc.
        const target = new URL(url);
        const validatedIP = await assertNotPrivate(target.hostname);

        // 6. Prepare & Send Request
        //
        // 🛡️ HMAC CONSISTENCY: `payloadString` is the exact string stored in
        //    MongoDB.  We sign it, then send it verbatim via `transformRequest`
        //    identity function — preventing Axios from re-serializing the body.
        //    This guarantees:  HMAC(stored) === HMAC(sent) === HMAC(received)
        const signature = createHmacSignature(payloadString, process.env.WEBHOOK_SECRET);

        // 🛡️ PIN AXIOS TO THE VALIDATED IP (Defeats DNS Rebinding / TOCTOU)
        // Without this, Axios performs its own internal DNS lookup which could
        // resolve to a different IP than the one we just validated — a classic
        // Time-of-Check to Time-of-Use attack.  By overriding the Agent's
        // `lookup` function, we force Axios to connect to the exact IP we
        // already verified is not private.
        //
        // ⚠️  IPv6 NOTE: If the URL resolves to an IPv6 address, ensure the
        // Docker container has IPv6 enabled (network_mode or enable_ipv6 in
        // docker-compose).  Some OS network stacks silently drop IPv6 even
        // when the lookup succeeds.
        const pinnedLookup = (_hostname, _opts, cb) => {
            if (typeof _opts === 'function') { cb = _opts; }
            cb(null, validatedIP, net.isIPv4(validatedIP) ? 4 : 6);
        };

        // 🛡️ ABSOLUTE WALL-CLOCK TIMEOUT (AbortController)
        // Axios' `timeout` only measures idle time between data chunks.
        // A "tarpit" server that trickles 1 byte/min keeps the socket
        // alive indefinitely.  AbortController enforces a strict 5-second
        // ceiling over the ENTIRE request lifecycle: DNS → TCP → TLS →
        // headers → body — regardless of how many bytes arrive.
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 5000);

        let response;
        try {
            response = await axios.post(url, payloadString, {
                headers: { 
                    'X-Signature': signature,
                    // 🛡️ TRACE HEADER: Receivers can use this to deduplicate
                    // deliveries.  AT_LEAST_ONCE semantics mean we may deliver
                    // twice if MongoDB drops between Axios success and persistState.
                    'X-Webhook-Trace-Id': tid,
                    'Content-Type': 'application/json' 
                },
                // 🛡️ PREVENT RE-SERIALIZATION: payloadString is already valid JSON.
                // Without this, Axios calls JSON.stringify() on the string, wrapping
                // it in extra quotes and breaking the receiver's HMAC verification.
                transformRequest: [data => data],
                timeout: 5000,
                signal: controller.signal, // Strict wall-clock abort

                // 🛡️ DNS-PINNED AGENTS: Axios will use our pre-validated IP
                httpAgent:  new http.Agent({ lookup: pinnedLookup }),
                httpsAgent: new https.Agent({ lookup: pinnedLookup }),

                // 🛡️ OOM PROTECTION
                maxContentLength:  1 * 1024 * 1024,
                maxBodyLength:     1 * 1024 * 1024,
                maxRedirects:      0,
            });
        } finally {
            clearTimeout(abortTimer); // Prevent timer leak on success/early failure
        }

        // 7. Handle Success
        //
        // ⚠️  DUAL-WRITE TRADE-OFF (The "Zombie Job" Problem)
        // If Axios succeeds but MongoDB drops before persistState(), BullMQ
        // retries the job → the webhook is delivered TWICE.  This is inherent
        // to AT_LEAST_ONCE_UNORDERED semantics and is mathematically
        // unavoidable without a two-phase commit or outbox pattern (the Two
        // Generals' Problem).  Receivers MUST deduplicate using the
        // X-Webhook-Trace-Id header we send above.
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
        // 8. Handle Failure

        // SSRF attempts are PERMANENT — never retry
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
            // 🛡️ FINAL ATTEMPT DETECTION: Handle DEAD transition INSIDE the
            // processor, not in the fire-and-forget worker.on('failed') listener.
            // If the process dies between BullMQ registering the 5th failure and
            // the listener executing, MongoDB would forever say FAILED instead
            // of DEAD.  Handling it here guarantees the transition is awaited.
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

        throw error; // Triggers BullMQ retry
    }
}, {
    connection: bullmqConnectionOptions,
    concurrency: 50,
    limiter: { max: 50, duration: 1000 }
});

// --- 💀 DEATH LISTENER (Safety Net) ---
// The DEAD transition is now handled inside the processor catch block above.
// This listener is a SAFETY NET: if the processor somehow fails to mark DEAD
// (e.g. a code path we missed), this will catch it.  It's idempotent —
// setting DEAD on an already-DEAD document is a no-op.
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

// --- 🎨 STARTUP LOGS ---
logger.info({ concurrency: 50, limiter: '50/s' }, 'Background worker active');

// --- 🛑 GRACEFUL SHUTDOWN ---
// BullMQ's worker.close() waits for ALL in-flight jobs to finish.
// If a malicious "tarpit" server trickles 1 byte/min, worker.close()
// blocks indefinitely and Docker/K8s eventually SIGKILLs us.
// The 15-second safety net mirrors the one in server.js.
const SHUTDOWN_TIMEOUT_MS = 15_000;

let shutdownInProgress = false;
async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    // 🛡️ TARPIT PROTECTION: Force-exit if draining takes too long.
    const forceTimer = setTimeout(() => {
        logger.error('Forced shutdown after drain timeout (15 s)');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref(); // Don't keep the event loop alive just for this

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

// Listen for both Ctrl+C (Local) and Docker/Kubernetes termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// --- 💥 UNHANDLED ERROR CATCHERS ---
// A single unhandled rejection or uncaught exception would otherwise
// crash the process silently.  These handlers log the fatal error,
// trigger a graceful drain, and exit cleanly so the container
// orchestrator (Docker/K8s) can spin up a healthy replacement.
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'UNCAUGHT EXCEPTION');
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'UNHANDLED REJECTION');
    gracefulShutdown('unhandledRejection');
});
