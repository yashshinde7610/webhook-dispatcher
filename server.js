// server.js
const connectDB = require('./src/db');
connectDB(); 
const redis = require('./src/redis'); 
const crypto = require('crypto'); 
const logger = require('./src/utils/logger');
const { redact, redactPayloadString } = require('./src/utils/redact');

require('dotenv').config();

// --- 🛡️ FAIL-FAST ENV VALIDATION ---
// Crash at boot — not after 10,000 requests have been accepted.
const REQUIRED_ENV = ['API_KEY', 'DASHBOARD_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    logger.fatal({ missing }, 'Missing required environment variables');
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
const { startSweeper, stopSweeper } = require('./src/services/zombieSweeper');

// --- 🛡️ CONSTANT-TIME STRING COMPARISON ---
// V8's === exits early on the first mismatched character, leaking key length
// via timing side-channels.  crypto.timingSafeEqual always compares the full
// buffers in constant time, defeating character-by-character guessing attacks.
const safeCompare = (a, b) => {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) {
        // Compare against itself so timing is still constant, but return false
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

// --- 🛡️ INPUT VALIDATION SCHEMAS ---
const eventSchema = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https'] }).required()
        .messages({ 'string.uri': 'url must be a valid HTTP/HTTPS URL' }),
    payload: Joi.object().required()
        .messages({ 'any.required': 'payload is required and must be a JSON object' })
}).options({ allowUnknown: true }); // Allow extra fields to pass through

// PATCH validation: only allow known, safe field types through the mask.
// This blocks NoSQL injection ($set, $gt, etc.) and wrong types before
// they reach MongoDB.
const patchSchema = Joi.object({
    status: Joi.string().valid('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'FAILED_PERMANENT', 'DEAD'),
    url: Joi.string().uri({ scheme: ['http', 'https'] }),
    payload: Joi.object(),
    failureType: Joi.string().valid('TRANSIENT', 'PERMANENT').allow(null),
    lastError: Joi.string().allow(null, ''),
}).options({ stripUnknown: true }); // Silently drop any unrecognised keys

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
    if (safeCompare(token, process.env.DASHBOARD_TOKEN)) {
        return next();
    }
    return next(new Error('Authentication error: Invalid Dashboard Token'));
});

// --- 🛡️ RAW BODY CAPTURE + PAYLOAD SIZE LIMIT ---
// 1. `verify` saves the exact bytes before parsing, giving us an authentic
//    reference for HMAC signature generation.  Webhook receivers hash the
//    raw bytes they receive; if we re-serialize, the hash will never match.
// 2. `limit` prevents a single request from OOM-killing the process.
//    Without it, a 500 MB JSON body would be buffered into memory.
app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
        req.rawBody = buf; // Save exact raw bytes (Buffer)
    }
}));
app.use(express.static('public'));

// --- 🛡️ INGRESS RATE LIMITING (Redis-Backed) ---
// Without this, 100k req/s exhausts Node memory or the MongoDB connection pool.
// Redis-backed store shares counters across all API replicas.
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const ingestLimiter = rateLimit({
    windowMs: 60 * 1000,           // 1 minute
    max: Number(process.env.RATE_LIMIT_RPM) || 1000, // 1000 req/min/IP
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
        sendCommand: (...args) => redis.call(...args),
    }),
    message: { error: 'Too Many Requests', code: 'RATE_LIMITED' },
});

// --- 📡 WEBSOCKET BATCHING ---
// At 5,000 webhooks/sec, emitting one WS message per job-update would choke
// the Node.js event loop and freeze every connected browser.  Instead, we
// buffer updates and flush them as a single array every WS_BATCH_INTERVAL_MS.
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

// --- 🛡️ MIDDLEWARE ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!safeCompare(apiKey, process.env.API_KEY)) {
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
app.post('/api/events', ingestLimiter, validateApiKey, async (req, res) => {
    const traceId = crypto.randomUUID(); 

    if (redis.status !== 'ready') {
        logger.error({ traceId, redisStatus: redis.status }, 'Redis unavailable at ingestion');
        return res.status(503).json({ 
            error: 'Service Unavailable', 
            message: 'Ingestion paused due to infrastructure outage.',
            code: 'INGESTION_PAUSED_REDIS_UNAVAILABLE', 
            traceId
        });
    }

    logger.info({ traceId }, 'Ingress: new request'); 
    
    // 🛡️ SCHEMA VALIDATION: Reject poison pills before they touch Redis/BullMQ
    const { error: validationError } = eventSchema.validate(req.body);
    if (validationError) {
        logger.warn({ traceId, err: validationError.message }, 'Validation failed');
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

    // 🛡️ SERIALIZE ONCE AT THE BOUNDARY
    // The payload is validated as a JSON object by Joi above, then
    // stringified here.  This single string is stored in MongoDB, signed
    // by the worker's HMAC, and sent on the wire — guaranteeing that
    // HMAC(stored) === HMAC(sent) === HMAC(received).
    const payloadString = JSON.stringify(jobData.payload);

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
                        payload: jobData.payload ? JSON.stringify(jobData.payload) : undefined,
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

            enqueueJobUpdate({ id: existing._id, status: 'Pending (Force Retry)', data: redactPayloadString(existing.payload), traceId });
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
            payload: payloadString,
            url: jobData.url,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
            status: 'PENDING',
            logs: [{ attempt: 0, status: 0, response: 'Ingested', timestamp: new Date() }]
        });

        await eventDoc.save();

        logger.info({ traceId, dbId: generatedDbId.toString() }, 'Event persisted');

        // Push to BullMQ
        await addToQueue({ 
            url: jobData.url,
            payload: payloadString,
            dbId: generatedDbId, 
            traceId,
            source: 'API_KEY_USER', 
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED'
        }); 

        // 🛡️ PII REDACTION: Never send raw payload to the dashboard.
        // The dashboard is a read-only observation layer; it does not need
        // the full payload contents.  Redact sensitive keys before emission.
        enqueueJobUpdate({ id: generatedDbId, status: 'Pending', data: redact(jobData), traceId });
        
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
            logger.warn({ traceId, idempotencyKey }, 'Idempotency collision (E11000)');
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

        logger.error({ traceId, err: error.message }, 'Ingestion error');
        res.status(500).json({ error: error.message, traceId });
    }
});

// --- 🔄 REPLAY ROUTE (Restored!) ---
// Supports replaying events in ANY terminal state: FAILED, FAILED_PERMANENT, DEAD.
// For FAILED events, BullMQ may still own the job (delayed/waiting for retry).
// We best-effort remove the old job, then add a fresh one with a unique replay
// jobId to avoid "job already exists" conflicts.
app.post('/api/events/:id/replay', validateApiKey, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid event ID' });
        }

        const eventLog = await Event.findById(req.params.id);
        
        if (!eventLog) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // 🛡️ Use findByIdAndUpdate to avoid Mongoose re-validating the entire
        // document.  Legacy events may have payload stored as Object (before the
        // schema was changed to String), and .save() would fail validation.
        await Event.findByIdAndUpdate(eventLog._id, {
            $set: {
                status: 'PENDING',
                attemptCount: 0,
                failureType: null,
                lastError: null,
                errorCode: null,
            },
            $push: {
                logs: {
                    attempt: (eventLog.logs?.length || 0) + 1,
                    status: 0,
                    response: 'Manual Replay Triggered',
                    timestamp: new Date()
                }
            }
        });

        const jobId = eventLog._id.toString();

        // 🛡️ BEST-EFFORT REMOVAL: For DEAD events the BullMQ job is already gone
        // (removeOnComplete: true). For FAILED events BullMQ still manages retries,
        // so the job may be in delayed/waiting/active state.  We try to remove it
        // to stop redundant retries, but if it fails (e.g. job is active) we
        // proceed anyway — the replay gets a unique jobId to avoid conflicts.
        const existingJob = await myQueue.getJob(jobId);
        if (existingJob) {
            try { await existingJob.remove(); } catch (_) {
                logger.warn({ jobId }, 'Could not remove existing BullMQ job for replay (may be active)');
            }
        }

        // 🛡️ UNIQUE REPLAY JOB ID: If the old BullMQ job couldn't be removed
        // (FAILED events still owned by BullMQ), using the same jobId would throw
        // "job already exists".  A timestamp-suffixed ID avoids the collision.
        // The worker still finds the MongoDB document via job.data.dbId.
        // The queueEvents handlers extract realId from job.data.dbId too.
        const replayJobId = existingJob ? `${jobId}-replay-${Date.now()}` : jobId;

        await myQueue.add('webhook-job', {
            url: eventLog.url,
            // 🛡️ Normalize: legacy events may have payload as Object instead of String
            payload: typeof eventLog.payload === 'object' ? JSON.stringify(eventLog.payload) : eventLog.payload,
            dbId: eventLog._id,
            traceId: eventLog.traceId,
            deliverySemantics: eventLog.deliverySemantics
        }, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            jobId: replayJobId,
            removeOnComplete: true,
            removeOnFail: false
        });

        enqueueJobUpdate({ id: eventLog._id, status: 'Pending (Replay)', data: redactPayloadString(eventLog.payload) });

        res.json({ message: 'Replay started', id: eventLog._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 🛠️ PATCH ROUTE (With Field Mask + Joi Validation) ---
app.patch('/api/events/:id', validateApiKey, async (req, res) => {
    const { id } = req.params;
    // Look in URL first, fallback to Header if URL fails
    const updateMask = req.query.updateMask || req.headers['x-update-mask'];
    const updateData = req.body;

    // 🛡️ SCHEMA VALIDATION: Blocks NoSQL operators ($set, $gt, etc.) and
    // invalid types before they ever reach MongoDB.  `stripUnknown: true`
    // silently drops any field not in the patchSchema allowlist.
    const { error: patchValidationError, value: validatedBody } = patchSchema.validate(updateData);
    if (patchValidationError) {
        return res.status(400).json({
            error: 'Bad Request',
            message: patchValidationError.details[0].message,
            code: 'PATCH_VALIDATION_FAILED'
        });
    }

    logger.debug({ id, mask: updateMask, bodyKeys: Object.keys(validatedBody) }, 'PATCH request');

    try {
        const safeUpdates = applyFieldMask(validatedBody, updateMask);

        // Stringify payload if present (stored as JSON string in MongoDB)
        if (safeUpdates.payload && typeof safeUpdates.payload === 'object') {
            safeUpdates.payload = JSON.stringify(safeUpdates.payload);
        }

        if (Object.keys(safeUpdates).length === 0) {
            return res.status(400).json({ 
                error: 'No valid fields to update. Did you provide an updateMask?',
                receivedMask: updateMask,
                receivedBody: validatedBody
            });
        }

        logger.info({ id, mask: updateMask }, 'Updating event');

        const result = await Event.updateOne({ _id: id }, { $set: safeUpdates });

        if (result.matchedCount === 0) return res.status(404).json({ error: 'Event not found' });

        enqueueJobUpdate({ 
            id: id, 
            status: safeUpdates.status || 'Updated', 
            response: `Patched fields: ${Object.keys(safeUpdates).join(', ')}` 
        });

        res.json({ message: 'Event updated successfully', updatedFields: Object.keys(safeUpdates) });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 📋 GET ROUTES (List + Detail) ---
// Added for dashboard data fetching and E2E test verification.
// Payloads are PII-redacted — the raw data stays in MongoDB only.

// --- ✨ AI SUGGEST-FIX ROUTE (Human-in-the-Loop DLQ) ---
// This route does NOT modify ANY data.  It is a read-only analysis endpoint.
// The user must manually review the suggestion, then explicitly call
// PATCH /api/events/:id + POST /api/events/:id/replay to apply it.
const { GoogleGenerativeAI } = require('@google/generative-ai');

app.post('/api/events/:id/suggest-fix', validateApiKey, async (req, res) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
        return res.status(501).json({
            error: 'AI suggestions are not configured',
            message: 'Set GEMINI_API_KEY in your environment to enable this feature.',
            code: 'GEMINI_NOT_CONFIGURED'
        });
    }

    try {
        // Validate ObjectId format before querying (prevents CastError on invalid IDs)
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid event ID format', code: 'INVALID_ID' });
        }

        const event = await Event.findById(req.params.id).lean();
        if (!event) return res.status(404).json({ error: 'Event not found', code: 'NOT_FOUND' });

        // Only suggest fixes for failed/dead events — not pending or completed
        const failedStatuses = ['FAILED', 'FAILED_PERMANENT', 'DEAD'];
        if (!failedStatuses.includes(event.status)) {
            return res.status(400).json({
                error: 'Event is not in a failed state',
                message: `Current status: ${event.status}. AI suggestions are only available for failed webhooks.`,
                code: 'NOT_FAILED'
            });
        }

        // Build the prompt with all available context
        let parsedPayload;
        try { parsedPayload = JSON.parse(event.payload); } catch { parsedPayload = event.payload; }

        const lastLogs = (event.logs || []).slice(-5).map(l => ({
            attempt: l.attempt,
            status: l.status,
            response: l.response,
            timestamp: l.timestamp
        }));

        const prompt = `You are a webhook delivery debugging assistant. A webhook delivery has failed.

TARGET URL: ${event.url}
STATUS: ${event.status}
FAILURE TYPE: ${event.failureType || 'Unknown'}
LAST ERROR: ${event.lastError || 'None'}
HTTP STATUS CODE: ${event.finalHttpStatus || 'N/A'}
ERROR CODE: ${event.errorCode || 'N/A'}
ATTEMPT COUNT: ${event.attemptCount || 0}

ORIGINAL PAYLOAD (JSON):
${JSON.stringify(parsedPayload, null, 2)}

RECENT DELIVERY LOGS:
${JSON.stringify(lastLogs, null, 2)}

TASK: Analyze the failure and suggest a FIXED JSON payload that is more likely to succeed on retry.

RULES:
1. Return ONLY a valid JSON object — no markdown fences, no explanation text outside the JSON.
2. The root response must be a JSON object with exactly these keys:
   - "analysis": a short human-readable string explaining what went wrong
   - "suggestion": a short string describing what you changed
   - "fixedPayload": the corrected JSON payload object (not stringified)
   - "confidence": a string, one of "high", "medium", or "low"
3. If the error is infrastructure-related (DNS, timeout, connection refused) and the payload looks correct, return the original payload unchanged in fixedPayload and set confidence to "low".
4. Do NOT invent fields that weren't in the original payload.
5. Keep the fixedPayload structure identical to the original — only fix values that are likely causing the failure.`;

        const genAI = new GoogleGenerativeAI(geminiKey);
        const primaryModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
        const fallbackModel = 'gemini-2.0-flash-lite';

        let responseText;
        try {
            const model = genAI.getGenerativeModel({ model: primaryModel });
            const result = await model.generateContent(prompt);
            responseText = result.response.text();
        } catch (primaryErr) {
            // If rate-limited on primary model, try fallback
            if (primaryErr.message && primaryErr.message.includes('429') && primaryModel !== fallbackModel) {
                logger.warn({ eventId: req.params.id, primary: primaryModel, fallback: fallbackModel }, 'Primary model rate-limited, trying fallback');
                try {
                    const fbModel = genAI.getGenerativeModel({ model: fallbackModel });
                    const fbResult = await fbModel.generateContent(prompt);
                    responseText = fbResult.response.text();
                } catch (fbErr) {
                    // Both models failed — return structured error
                    const isQuota = fbErr.message && (fbErr.message.includes('429') || fbErr.message.includes('quota'));
                    return res.status(isQuota ? 429 : 502).json({
                        error: 'AI service temporarily unavailable',
                        message: isQuota
                            ? 'Gemini API quota exceeded on all models. Please wait a few minutes or upgrade your plan at https://aistudio.google.com.'
                            : fbErr.message,
                        code: isQuota ? 'QUOTA_EXCEEDED' : 'AI_ERROR'
                    });
                }
            } else {
                // Non-429 error or no fallback possible
                const isQuota = primaryErr.message && (primaryErr.message.includes('429') || primaryErr.message.includes('quota'));
                return res.status(isQuota ? 429 : 502).json({
                    error: isQuota ? 'AI service temporarily unavailable' : 'AI request failed',
                    message: isQuota
                        ? 'Gemini API quota exceeded. Please wait a few minutes or upgrade your plan at https://aistudio.google.com.'
                        : primaryErr.message,
                    code: isQuota ? 'QUOTA_EXCEEDED' : 'AI_ERROR'
                });
            }
        }

        // Parse the AI response — strip markdown fences if present
        let aiResponse;
        try {
            const cleaned = responseText
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```\s*$/i, '')
                .trim();
            aiResponse = JSON.parse(cleaned);
        } catch (parseErr) {
            logger.warn({ eventId: req.params.id, raw: responseText.slice(0, 500) }, 'Gemini returned unparseable response');
            return res.status(502).json({
                error: 'AI returned an invalid response',
                message: 'The model response could not be parsed as JSON. Try again.',
                code: 'AI_PARSE_ERROR',
                raw: responseText.slice(0, 1000)
            });
        }

        logger.info({ eventId: req.params.id, confidence: aiResponse.confidence }, 'AI suggestion generated');

        res.json({
            eventId: event._id,
            currentStatus: event.status,
            analysis: aiResponse.analysis || 'No analysis provided',
            suggestion: aiResponse.suggestion || 'No suggestion provided',
            fixedPayload: aiResponse.fixedPayload || parsedPayload,
            confidence: aiResponse.confidence || 'low',
            originalPayload: parsedPayload
        });

    } catch (error) {
        logger.error({ eventId: req.params.id, err: error.message }, 'AI suggest-fix failed');
        res.status(500).json({ error: 'AI suggestion failed', message: error.message });
    }
});
app.get('/api/events', validateApiKey, async (req, res) => {
    try {
        const page  = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        const filter = {};
        if (req.query.status) filter.status = req.query.status;

        const [events, total] = await Promise.all([
            Event.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Event.countDocuments(filter)
        ]);

        res.json({
            events: events.map(e => ({
                ...e,
                payload: e.payload ? redactPayloadString(e.payload) : null
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/events/:id', validateApiKey, async (req, res) => {
    try {
        const event = await Event.findById(req.params.id).lean();
        if (!event) return res.status(404).json({ error: 'Event not found' });

        res.json({
            ...event,
            payload: event.payload ? redactPayloadString(event.payload) : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 🗑️ DELETE ROUTE (Cleanup + Testing) ---
app.delete('/api/events/:id', validateApiKey, async (req, res) => {
    try {
        const result = await Event.findByIdAndDelete(req.params.id);
        if (!result) return res.status(404).json({ error: 'Event not found' });
        res.json({ message: 'Event deleted', id: req.params.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => { 
    // --- 🎨 STARTUP LOG (structured, not blocking) ---
    logger.info({
        port: PORT,
        security: 'HMAC + API Key',
        idempotency: 'MongoDB-Backed (unique index)',
        webSocket: 'Redis-Adapted (multi-replica)',
        rateLimitRpm: Number(process.env.RATE_LIMIT_RPM) || 1000,
    }, 'Webhook API server ONLINE');

    // --- 🧹 START ZOMBIE SWEEPER (Outbox Pattern) ---
    startSweeper();
});

// --- 🛑 GRACEFUL SHUTDOWN ---
// The shutdown sequence MUST drain in-flight HTTP requests before closing
// database connections.  Without this, a SIGTERM during a POST /api/events
// would kill the MongoDB connection mid-save → MongoNotConnectedError → 500.
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    // 1. Stop the zombie sweeper immediately (no more DB reads)
    stopSweeper();

    // 2. Stop accepting NEW connections, then wait for in-flight requests
    //    to complete.  The callback fires only after every open socket has
    //    been fully served and closed.
    server.close(async (err) => {
        if (err) logger.error({ err }, 'Error draining HTTP connections');
        else     logger.info('HTTP server drained — all requests completed');

        try {
            // 3. Now safe to close the database (no in-flight queries)
            logger.info('Closing MongoDB connection...');
            await mongoose.connection.close();

            // 4. Disconnect Socket.IO Redis adapters
            pubClient.disconnect();
            subClient.disconnect();

            // 5. Close the app Redis connection
            logger.info('Closing Redis connection...');
            await redis.quit();

            logger.info('Shutdown complete');
            process.exit(0);
        } catch (shutdownErr) {
            logger.error({ err: shutdownErr }, 'Shutdown error');
            process.exit(1);
        }
    });

    // Safety net: if draining takes too long (e.g. hung keep-alive sockets),
    // force-exit after 15 seconds to avoid blocking orchestrator restarts.
    setTimeout(() => {
        logger.error('Forced shutdown after drain timeout (15 s)');
        process.exit(1);
    }, 15_000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
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