// server.js
const connectDB = require('./src/db');
connectDB();
const redis = require('./src/redis');
const crypto = require('crypto');
const logger = require('./src/utils/logger');
require('dotenv').config();

// Crash at startup if critical env vars are missing
const REQUIRED_ENV = ['API_KEY', 'DASHBOARD_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    logger.fatal({ missing }, 'Missing required environment variables');
    process.exit(1);
}

const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const { myQueue } = require('./src/queue');
const { QueueEvents } = require('bullmq');
const { startSweeper, stopSweeper } = require('./src/services/zombieSweeper');
const eventRoutes = require('./src/api/routes/eventRoutes');

// Constant-time string comparison to prevent timing side-channel attacks
const safeCompare = (a, b) => {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Redis adapter for Socket.IO
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');
const pubClient = new IORedis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT) || 6379 });
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));

// WebSocket auth — dashboard uses a separate read-only token
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (safeCompare(token, process.env.DASHBOARD_TOKEN)) {
        return next();
    }
    return next(new Error('Authentication error: Invalid Dashboard Token'));
});

// Body parsing with raw body capture for HMAC verification
app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.static('public'));

// WebSocket batching
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

// Queue event listeners
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
        try {
            result = JSON.parse(returnvalue);
        } catch (e) {
            result = { status: 'Completed', response: returnvalue };
        }
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

// Middleware for API Key Validation
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!safeCompare(apiKey, process.env.API_KEY)) {
        return res.status(403).json({ error: 'Access Denied: Invalid API Key' });
    }
    next();
};

// Mount API routes
app.use('/api/events', validateApiKey, eventRoutes(enqueueJobUpdate));

// Dashboard health heartbeat (every 2s)
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
    } catch (err) { /* metrics are best-effort */ }
}, 2000);

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    logger.info({
        port: PORT,
        security: 'HMAC + API Key',
        idempotency: 'MongoDB-Backed (unique index)',
        webSocket: 'Redis-Adapted (multi-replica)',
        rateLimitRpm: Number(process.env.RATE_LIMIT_RPM) || 1000,
    }, 'Webhook API server ONLINE');

    startSweeper();
});

// Graceful shutdown
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
        logger.error('Forced shutdown after drain timeout (15 s)');
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