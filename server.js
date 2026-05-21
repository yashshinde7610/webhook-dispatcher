// server.js — API entry point
// Sets up Express, Socket.IO, queue listeners, and mounts routes.
// Business logic lives in src/api/controllers/.

// ── Load .env FIRST — before any module that reads process.env ──
require('dotenv').config();

const logger = require('./src/utils/logger');

// Crash fast if critical env vars are missing
const REQUIRED_ENV = ['API_KEY', 'DASHBOARD_TOKEN', 'WEBHOOK_SECRET'];
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
const { startTailer, stopTailer } = require('./src/services/outboxTailer');
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
        origin: process.env.DASHBOARD_ORIGIN || false,
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
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com"],
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

// ── Queue event listeners ──
// Emit job updates directly via Socket.IO. The Redis adapter fans these
// out to every connected dashboard client across all server replicas.
// No local buffer needed — each server independently receives BullMQ
// events and emits them, keeping the dashboard consistent under scale.
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

    const realId = (result && result.dbId) ? result.dbId : jobId;
    logger.info({ jobId: realId }, 'Job completed');
    io.emit('job-update-batch', [{
        id: realId,
        status: result.status || 'Completed',
        timestamp: new Date(),
        response: result.response || result
    }]);
});

queueEvents.on('failed', async ({ jobId, failedReason }) => {
    let realId = jobId;
    try {
        const job = await myQueue.getJob(jobId);
        if (job && job.data.dbId) realId = job.data.dbId;
    } catch (e) { logger.error({ err: e }, 'Could not fetch failed job details'); }

    logger.info({ jobId: realId, reason: failedReason }, 'Job failed');
    io.emit('job-update-batch', [{ id: realId, status: 'Failed', reason: failedReason }]);
});

// ── Mount routes ──
app.use('/api/events', validateApiKey, eventRoutes);

// Dashboard health heartbeat
const dashboardStatsTimer = setInterval(async () => {
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

        startTailer();
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

    stopTailer();
    clearInterval(dashboardStatsTimer);

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