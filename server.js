// server.js — API entry point
// Sets up Express, Socket.IO, queue listeners, and mounts routes.
// Business logic lives in src/api/controllers/.

// ── Load .env FIRST — before any module that reads process.env ──
require('dotenv').config();

const logger = require('./src/utils/logger');

// Crash fast if critical env vars are missing
const REQUIRED_ENV = ['API_KEY', 'DASHBOARD_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    logger.fatal({ missing }, 'Missing required environment variables');
    process.exit(1);
}

const express = require('express');
const helmet = require('helmet');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const { myQueue } = require('./src/queue');
const { QueueEvents } = require('bullmq');
const { startSweeper, stopSweeper } = require('./src/services/zombieSweeper');
const { validateApiKey, safeCompare } = require('./src/api/middleware');
const eventRoutes = require('./src/api/routes/eventRoutes');
const connectDB = require('./src/db');
const redis = require('./src/redis');
const { redactPayloadString } = require('./src/utils/redact');

const app = express();
const server = http.createServer(app);

// ── Socket.IO: restrict CORS in production ──
const io = new Server(server, {
    cors: {
        origin: process.env.DASHBOARD_ORIGIN || '*',
    }
});

// ── Socket.IO: Redis adapter for multi-replica pub/sub ──
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');
const pubClient = new IORedis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT) || 6379 });
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));

// Dashboard websocket auth (separate read-only token)
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (safeCompare(token, process.env.DASHBOARD_TOKEN)) return next();
    return next(new Error('Authentication error: Invalid Dashboard Token'));
});

// ── Express middleware ──
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "ws:", "wss:"],
            imgSrc: ["'self'", "data:"]
        }
    }
}));
app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.static('public'));

// ── WebSocket batching ──
// At high throughput, emitting per-job updates would choke the event loop.
// Buffer updates and flush as a batch instead.
const WS_BATCH_INTERVAL_MS = Number(process.env.WS_BATCH_INTERVAL_MS) || 500;
let jobUpdateBuffer = [];

function enqueueJobUpdate(update) {
    jobUpdateBuffer.push(update);
}

setInterval(() => {
    if (jobUpdateBuffer.length === 0) return;
    const batch = jobUpdateBuffer;
    jobUpdateBuffer = [];
    io.emit('job-update-batch', batch);
}, WS_BATCH_INTERVAL_MS);

// Make enqueueJobUpdate available to controllers via app.locals
// (avoids threading callbacks through factory functions)
app.locals.enqueueJobUpdate = enqueueJobUpdate;

// ── Queue event listeners ──
const queueEvents = new QueueEvents('webhook-queue', {
    connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379
    }
});

queueEvents.on('completed', ({ jobId, returnvalue }) => {
    let result = {};
    if (typeof returnvalue === 'object') {
        result = returnvalue;
    } else if (typeof returnvalue === 'string') {
        try { result = JSON.parse(returnvalue); }
        catch (e) { result = { status: 'Completed', response: returnvalue }; }
    }

    let realId = jobId;
    if (result && result.dbId) realId = result.dbId;

    logger.info({ jobId: realId }, 'Job completed');
    enqueueJobUpdate({
        id: realId,
        status: result.status || 'Completed',
        timestamp: new Date(),
        response: result.response || result
    });
});

queueEvents.on('failed', async ({ jobId, failedReason }) => {
    let realId = jobId;
    try {
        const job = await myQueue.getJob(jobId);
        if (job && job.data.dbId) realId = job.data.dbId;
    } catch (e) { logger.error({ err: e }, 'Could not fetch failed job details'); }

    logger.info({ jobId: realId, reason: failedReason }, 'Job failed');
    enqueueJobUpdate({ id: realId, status: 'Failed', reason: failedReason });
});

// ── Mount routes ──
app.use('/api/events', validateApiKey, eventRoutes);

// Dashboard health heartbeat
setInterval(async () => {
    try {
        const counts = await myQueue.getJobCounts('waiting', 'active', 'completed', 'failed');
        io.emit('dashboard-stats', {
            waiting: counts.waiting,
            active: counts.active,
            failed: counts.failed,
            completed: counts.completed,
            redisStatus: redis.status
        });
    } catch (err) { /* best-effort */ }
}, 2000);

// ── Start ──
// Await MongoDB connection before binding the port.
// If Mongo is unreachable, connectDB() calls process.exit(1).
const PORT = process.env.PORT || 3000;

(async () => {
    await connectDB();

    server.listen(PORT, () => {
        logger.info({
            port: PORT,
            security: 'HMAC + API Key + Helmet',
            idempotency: 'MongoDB-Backed (unique index)',
            webSocket: 'Redis-Adapted (multi-replica)',
            rateLimitRpm: Number(process.env.RATE_LIMIT_RPM) || 1000,
        }, 'Webhook API server ONLINE');

        startSweeper();
    });
})();

// ── Graceful shutdown ──
// Drain in-flight HTTP requests before closing DB connections,
// otherwise SIGTERM during a POST kills Mongo mid-save.
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    stopSweeper();

    server.close(async (err) => {
        if (err) logger.error({ err }, 'Error draining HTTP connections');
        else     logger.info('HTTP server drained');

        try {
            await mongoose.connection.close();
            pubClient.disconnect();
            subClient.disconnect();
            await redis.quit();
            logger.info('Shutdown complete');
            process.exit(0);
        } catch (shutdownErr) {
            logger.error({ err: shutdownErr }, 'Shutdown error');
            process.exit(1);
        }
    });

    // Force-exit after 15s if draining hangs
    setTimeout(() => {
        logger.error('Forced shutdown after drain timeout (15s)');
        process.exit(1);
    }, 15_000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'UNCAUGHT EXCEPTION');
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'UNHANDLED REJECTION');
    gracefulShutdown('unhandledRejection');
});