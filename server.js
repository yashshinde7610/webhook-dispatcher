// server.js
const connectDB = require('./src/db');
connectDB(); 
const redis = require('./src/redis'); 
const crypto = require('crypto'); 
const chalk = require('chalk');   
const figlet = require('figlet'); 

require('dotenv').config();

// --- 🛡️ FAIL-FAST ENV VALIDATION ---
// Crash at boot — not after 10,000 requests have been accepted.
const REQUIRED_ENV = ['API_KEY', 'DASHBOARD_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Set them in .env or your deployment config before starting the server.');
    process.exit(1);
}

const Event = require('./src/models/Event'); 
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const { addToQueue, myQueue } = require('./src/queue');
const { QueueEvents } = require('bullmq'); 
const { applyFieldMask } = require('./src/utils/fieldMask'); 
const Joi = require('joi');

// --- 🛡️ INPUT VALIDATION SCHEMA ---
const eventSchema = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https'] }).required()
        .messages({ 'string.uri': 'url must be a valid HTTP/HTTPS URL' }),
    payload: Joi.object().required()
        .messages({ 'any.required': 'payload is required and must be a JSON object' })
}).options({ allowUnknown: true }); // Allow extra fields to pass through

const app = express();
const server = http.createServer(app); 
const io = new Server(server); 

// --- 🌐 SOCKET.IO REDIS ADAPTER (Horizontal Scaling) ---
// Without this, io.emit() only reaches clients connected to THIS process.
// With the adapter, events are published to Redis Pub/Sub and broadcast
// across all replicas — no more split-brain real-time communication.
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');
const pubClient = new IORedis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT) || 6379 });
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));

// (Atomic force-retry Lua script removed — idempotency is now backed
// by a MongoDB unique sparse index on Event.idempotencyKey.  See POST route.)

// --- 🛡️ WEBSOCKET AUTH MIDDLEWARE ---
// Dashboard uses a separate read-only DASHBOARD_TOKEN.
// The backend API_KEY is NEVER exposed to the browser.
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token === process.env.DASHBOARD_TOKEN) {
        return next();
    }
    return next(new Error('Authentication error: Invalid Dashboard Token'));
});

app.use(express.json());
app.use(express.static('public')); 

// --- 🎧 QUEUE LISTENER ---
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

    console.log(`⚡ Event: Job ${realId} completed!`);
    
    io.emit('job-update', { 
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
    } catch (e) { console.error("⚠️ Could not fetch failed job details"); }

    console.log(`⚡ Event: Job ${realId} failed!`);
    io.emit('job-update', { id: realId, status: 'Failed', reason: failedReason });
});

// --- 🛡️ MIDDLEWARE ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({ error: '⛔ Access Denied: Invalid API Key' });
    }
    next();
};

// --- 📊 SYSTEM HEALTH HEARTBEAT ---
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
    } catch (err) {
        // console.error('Metrics Error:', err.message); 
    }
}, 2000);

// --- 📥 POST ROUTE (Ingestion) ---
// ARCHITECTURE: This is the ONLY place Event documents are created.
// Idempotency is enforced via a unique sparse MongoDB index on
// `idempotencyKey` — no Redis RAM pressure, survives restarts,
// and keys live as long as the event (days/months), not 5 minutes.
app.post('/api/events', validateApiKey, async (req, res) => {
    const traceId = crypto.randomUUID(); 

    if (redis.status !== 'ready') {
        console.error(`[Trace: ${traceId}] 🛑 Critical: Redis is ${redis.status}`);
        return res.status(503).json({ 
            error: 'Service Unavailable', 
            message: 'Ingestion paused due to infrastructure outage.',
            code: 'INGESTION_PAUSED_REDIS_UNAVAILABLE', 
            traceId
        });
    }

    console.log(`[Trace: ${traceId}] 🔍 Ingress: New Request`); 
    
    // 🛡️ SCHEMA VALIDATION: Reject poison pills before they touch Redis/BullMQ
    const { error: validationError } = eventSchema.validate(req.body);
    if (validationError) {
        console.warn(`[Trace: ${traceId}] 🛑 Validation Failed: ${validationError.message}`);
        return res.status(400).json({
            error: 'Bad Request',
            message: validationError.details[0].message,
            code: 'VALIDATION_FAILED',
            traceId
        });
    }

    const idempotencyKey = req.headers['idempotency-key'] || null;
    const forceRetry = req.headers['x-force-retry'] === 'true';
    const jobData = req.body;

    try {
        // --- FORCE RETRY PATH ---
        // Atomically claim the retry via findOneAndUpdate with a status guard.
        // If two concurrent retries race, only one wins (the $ne:'PENDING' filter).
        if (idempotencyKey && forceRetry) {
            const existing = await Event.findOneAndUpdate(
                { idempotencyKey, status: { $ne: 'PENDING' } },
                {
                    $set: {
                        status: 'PENDING',
                        url: jobData.url || undefined,
                        payload: jobData.payload || undefined,
                    },
                    $push: {
                        logs: {
                            $each: [{ attempt: 0, status: 0, response: 'Force Retry', timestamp: new Date() }],
                            $slice: -(Event.MAX_LOGS || 20)
                        }
                    }
                },
                { new: true }
            );

            if (!existing) {
                const found = await Event.findOne({ idempotencyKey });
                if (!found) {
                    return res.status(404).json({ error: 'No event found for this idempotency key', traceId });
                }
                return res.status(409).json({
                    error: 'Conflict',
                    message: 'Event is already pending or a retry is in progress',
                    existingId: found._id,
                    existingStatus: found.status,
                    traceId
                });
            }

            // Remove any stuck BullMQ job, then re-queue
            const existingJob = await myQueue.getJob(existing._id.toString());
            if (existingJob) await existingJob.remove();

            await addToQueue({
                url: existing.url,
                payload: existing.payload,
                dbId: existing._id,
                traceId: existing.traceId,
                source: existing.source,
                deliverySemantics: existing.deliverySemantics || 'AT_LEAST_ONCE_UNORDERED'
            });

            io.emit('job-update', { id: existing._id, status: 'Pending (Force Retry)', data: existing.payload, traceId });
            return res.status(202).json({
                status: 'accepted',
                message: 'Force retry queued',
                id: existing._id,
                traceId
            });
        }

        // --- NORMAL INGESTION PATH ---
        const generatedDbId = new mongoose.Types.ObjectId();

        // Create the Event document in MongoDB.  If an idempotencyKey is
        // provided and already exists, the unique sparse index throws E11000
        // — instant atomic dedup, no Redis RAM pressure, survives restarts.
        const eventDoc = new Event({
            _id: generatedDbId,
            traceId,
            source: 'API_KEY_USER',
            payload: jobData.payload,
            url: jobData.url,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
            status: 'PENDING',
            logs: [{ attempt: 0, status: 0, response: 'Ingested', timestamp: new Date() }]
        });

        await eventDoc.save();

        console.log(`[Trace: ${traceId}] 📦 Event persisted & queued. Mongo ID: ${generatedDbId}`);

        // Push to BullMQ
        await addToQueue({ 
            ...jobData, 
            dbId: generatedDbId, 
            traceId,
            source: 'API_KEY_USER', 
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED'
        }); 

        // Emit real-time update
        io.emit('job-update', { id: generatedDbId, status: 'Pending', data: jobData, traceId });
        
        // Respond to client immediately
        res.status(202).json({ 
            status: 'accepted', 
            message: 'Job pushed to queue', 
            id: generatedDbId,
            traceId 
        });

    } catch (error) {
        // E11000 = duplicate idempotencyKey → return cached status
        if (error.code === 11000 && idempotencyKey) {
            console.warn(`[Trace: ${traceId}] 🛑 Idempotency collision (E11000)`);
            try {
                const existing = await Event.findOne({ idempotencyKey });
                if (existing) {
                    return res.status(409).json({
                        error: 'Conflict',
                        message: 'Event already processed',
                        existingId: existing._id,
                        existingStatus: existing.status,
                        traceId
                    });
                }
            } catch (_) { /* fall through */ }
            return res.status(409).json({ error: 'Conflict', message: 'Duplicate idempotency key', traceId });
        }

        console.error(`[Trace: ${traceId}] 💥 Error: ${error.message}`);
        res.status(500).json({ error: error.message, traceId });
    }
});

// --- 🔄 REPLAY ROUTE (Restored!) ---
app.post('/api/events/:id/replay', validateApiKey, async (req, res) => {
    try {
        const eventLog = await Event.findById(req.params.id);
        
        if (!eventLog) {
            return res.status(404).json({ error: 'Event not found' });
        }

        eventLog.status = 'PENDING';
        eventLog.logs.push({ 
            attempt: eventLog.logs.length + 1, 
            status: 0, 
            response: 'Manual Replay Triggered' 
        });
        await eventLog.save();

        const jobId = eventLog._id.toString();
        const existingJob = await myQueue.getJob(jobId);
        if (existingJob) {
            await existingJob.remove(); 
        }

        // 🛡️ FIX: Explicitly pass top-level fields from the stored document.
        // Spreading eventLog.payload here would flatten inner data to root,
        // losing url/traceId/deliverySemantics and crashing the worker.
        await addToQueue({ 
            url: eventLog.url,
            payload: eventLog.payload,
            dbId: eventLog._id,
            traceId: eventLog.traceId,
            deliverySemantics: eventLog.deliverySemantics
        });

        io.emit('job-update', { id: eventLog._id, status: 'Pending (Replay)', data: eventLog.payload });

        res.json({ message: 'Replay started', id: eventLog._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 🛠️ PATCH ROUTE (With Field Mask) ---
app.patch('/api/events/:id', validateApiKey, async (req, res) => {
    const { id } = req.params;
    // Look in URL first, fallback to Header if URL fails
const updateMask = req.query.updateMask || req.headers['x-update-mask'];
    const updateData = req.body;

    console.log('🔍 DEBUG PATCH:', { id, mask: updateMask, bodyKeys: Object.keys(updateData) });

    try {
        const safeUpdates = applyFieldMask(updateData, updateMask);

        if (Object.keys(safeUpdates).length === 0) {
            return res.status(400).json({ 
                error: 'No valid fields to update. Did you provide an updateMask?',
                receivedMask: updateMask,
                receivedBody: updateData
            });
        }

        console.log(`[Patch] Updating Event ${id} with mask [${updateMask}]`);

        const result = await Event.updateOne({ _id: id }, { $set: safeUpdates });

        if (result.matchedCount === 0) return res.status(404).json({ error: 'Event not found' });

        io.emit('job-update', { 
            id: id, 
            status: safeUpdates.status || 'Updated', 
            response: `Patched fields: ${Object.keys(safeUpdates).join(', ')}` 
        });

        res.json({ message: 'Event updated successfully', updatedFields: Object.keys(safeUpdates) });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => { 
    console.clear(); 
    
    // Big Text Banner
    console.log(
        chalk.green(
            figlet.textSync('Webhook API', { horizontalLayout: 'full' })
        )
    );

    // Status Panel
    console.log(chalk.blue.bold('\n🔹 SYSTEM STATUS DASHBOARD 🔹'));
    console.log(chalk.gray('-----------------------------------'));
    console.log(`✅  Server Status:    ${chalk.green('ONLINE')}`);
    console.log(`🔗  Port:             ${chalk.yellow(PORT)}`);
    console.log(`🔑  Security:         ${chalk.cyan('HMAC + API Key Active')}`);
    console.log(`🧠  Idempotency:      ${chalk.magenta('MongoDB-Backed (unique index)')}`);
    console.log(`🌐  WebSocket:        ${chalk.magenta('Redis-Adapted (multi-replica)')}`);
    console.log(chalk.gray('-----------------------------------'));
    console.log(chalk.white('Waiting for incoming events...'));
});

// --- 🛑 GRACEFUL SHUTDOWN ---
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(chalk.yellow.bold(`\n🛑 Received ${signal}. Shutting down...`));
    try {
        server.close();
        await mongoose.connection.close();
        pubClient.disconnect();
        subClient.disconnect();
        await redis.quit();
        console.log(chalk.green('✅ Shutdown complete. Goodbye!'));
        process.exit(0);
    } catch (err) {
        console.error(chalk.red('💥 Shutdown error:'), err);
        process.exit(1);
    }
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// --- 💥 UNHANDLED ERROR CATCHERS ---
// A single unhandled rejection or uncaught exception would otherwise
// crash the process silently.  These handlers log the fatal error,
// trigger a graceful drain, and exit cleanly so the container
// orchestrator (Docker/K8s) can spin up a healthy replacement.
process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT EXCEPTION:', err);
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 UNHANDLED REJECTION:', reason);
    gracefulShutdown('unhandledRejection');
});