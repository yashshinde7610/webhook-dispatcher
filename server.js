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
const REQUIRED_ENV = ['API_KEY'];
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

// --- 🛡️ ATOMIC FORCE-RETRY LUA SCRIPT ---
// This runs inside Redis's single-threaded Lua engine, so the entire
// read → claim → refresh sequence is indivisible. No TOCTOU possible.
//
// KEYS[1] = idempotency key       (e.g. "idempotency:abc-123")
// KEYS[2] = short-lived claim key (e.g. "idempotency:abc-123:retry_claim")
// ARGV[1] = new lock payload      (JSON with the dbId)
// ARGV[2] = main lock TTL         (seconds)
// ARGV[3] = claim lock TTL        (seconds, short — just to block overlapping retries)
//
// Returns:
//   existing lock value (string) → caller won, reuse the dbId inside
//   ""                           → caller won, no prior lock existed
//   nil                          → caller lost, another retry is in progress → 409
const FORCE_RETRY_LUA = `
local claimed = redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3]))
if not claimed then
    return nil
end
local existing = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return existing
`;

// --- 🛡️ WEBSOCKET AUTH MIDDLEWARE ---
// Prevents unauthenticated users from intercepting webhook payloads via WebSocket.
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token === process.env.API_KEY) {
        return next();
    }
    return next(new Error('Authentication error: Invalid API Key'));
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

    const idempotencyKey = req.headers['idempotency-key'];
    const forceRetry = req.headers['x-force-retry'] === 'true';
    const jobData = req.body;

        try {
        // 1. Generate MongoDB ID synchronously FIRST
        let generatedDbId = new mongoose.Types.ObjectId();

        // 2. ⚡ ATOMIC Idempotency Lock (Fixes TOCTOU Race Condition)
        if (idempotencyKey) {
            const key = `idempotency:${idempotencyKey}`;

            if (!forceRetry) {
                const lockPayload = JSON.stringify({ id: generatedDbId });
                // 'NX' ensures this ONLY writes if the key does not exist.
                // It is a single atomic operation evaluated inside the Redis engine.
                const acquired = await redis.set(key, lockPayload, 'EX', 300, 'NX');
                
                if (!acquired) {
                    console.warn(`[Trace: ${traceId}] 🛑 Atomic Idempotency Block (Race condition averted)`);
                    return res.status(409).json({ 
                        error: 'Conflict', 
                        message: 'Event already processed', 
                        traceId 
                    });
                }
            } else {
                // 🛡️ ATOMIC FORCE-RETRY: Single Lua script eliminates the TOCTOU
                // race between GET (read old dbId) and SET (refresh lock).
                // The claim key ensures only ONE concurrent retry wins.
                const claimKey = `${key}:retry_claim`;
                const newPayload = JSON.stringify({ id: generatedDbId });

                const existing = await redis.eval(
                    FORCE_RETRY_LUA,
                    2,              // number of KEYS
                    key, claimKey,  // KEYS[1], KEYS[2]
                    newPayload,     // ARGV[1] — new lock payload
                    '300',          // ARGV[2] — main lock TTL (seconds)
                    '5'             // ARGV[3] — claim lock TTL (seconds)
                );

                // nil → another force-retry already in progress
                if (existing === null) {
                    console.warn(`[Trace: ${traceId}] 🛑 Force-retry lost claim race (concurrent retry in progress)`);
                    return res.status(409).json({
                        error: 'Conflict',
                        message: 'A force-retry for this idempotency key is already in progress',
                        traceId
                    });
                }

                // Reuse the original dbId if the lock contained one
                if (existing && existing.length > 0) {
                    try {
                        const parsed = JSON.parse(existing);
                        if (parsed.id) {
                            generatedDbId = new mongoose.Types.ObjectId(parsed.id);
                        }
                    } catch (_) { /* Lock corrupted, proceed with new ID */ }
                }
            }
        }
        
        console.log(`[Trace: ${traceId}] 📦 Job Queued to Redis. Mongo ID reserved: ${generatedDbId}`);

        // 3. Push directly to Redis (BullMQ is extremely fast)
        await addToQueue({ 
            ...jobData, 
            dbId: generatedDbId, 
            traceId,
            source: 'API_KEY_USER', 
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED'
        }); 

        // 4. Emit real-time update
        io.emit('job-update', { id: generatedDbId, status: 'Pending', data: jobData, traceId });
        
        // 5. Respond to client immediately
        res.status(202).json({ 
            status: 'accepted', 
            message: 'Job pushed to queue', 
            id: generatedDbId,
            traceId 
        });

    } catch (error) {
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
    console.log(`🧠  Idempotency:      ${chalk.magenta('Redis-Backed')}`);
    console.log(chalk.gray('-----------------------------------'));
    console.log(chalk.white('Waiting for incoming events...'));
});