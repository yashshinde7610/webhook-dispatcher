// src/api/controllers/eventController.js
// Handles all /api/events endpoint logic.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Joi = require('joi');

const Event = require('../../models/Event');
const redis = require('../../redis');
const logger = require('../../utils/logger');
const { redact, redactPayloadString } = require('../../utils/redact');
const { applyFieldMask } = require('../../utils/fieldMask');
const { addToQueue, myQueue } = require('../../queue');

// Safe accessor for the WebSocket broadcast function injected by server.js
// via app.locals. Returns a no-op if not set (e.g. in test contexts).
const noop = () => {};
function getEnqueueFn(req) {
    return req.app?.locals?.enqueueJobUpdate || noop;
}

// Validation schemas
const eventSchema = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https'] }).required()
        .messages({ 'string.uri': 'url must be a valid HTTP/HTTPS URL' }),
    payload: Joi.object().required()
        .messages({ 'any.required': 'payload is required and must be a JSON object' })
}).options({ allowUnknown: true });

// PATCH schema — status and failureType are intentionally excluded.
// These fields are owned by the worker lifecycle; letting external callers
// set them directly causes MongoDB ↔ BullMQ desync (e.g. marking a
// PENDING job as COMPLETED while BullMQ still has it in-flight).
const patchSchema = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https'] }),
    payload: Joi.object(),
    lastError: Joi.string().allow(null, ''),
}).options({ stripUnknown: true });

// ── Ingest (POST /api/events) ──
// Idempotency is enforced via a unique sparse MongoDB index on
// idempotencyKey — E11000 on collision gives atomic dedup.
exports.ingestEvent = async (req, res) => {
    const enqueueJobUpdate = getEnqueueFn(req);
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

    // Serialize payload once at the boundary — this string flows through
    // MongoDB, BullMQ, HMAC signing, and Axios without re-serialization
    const payloadString = JSON.stringify(jobData.payload);

    try {
        // Force retry: atomically claim the retry with a status guard
        // so only one concurrent retry wins
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

        // Normal ingestion path
        const generatedDbId = new mongoose.Types.ObjectId();

        const eventDoc = new Event({
            _id: generatedDbId,
            traceId,
            source: 'API_KEY_USER',
            payload: payloadString,
            url: jobData.url,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            // deliverySemantics uses schema default ('AT_LEAST_ONCE_UNORDERED')
            status: 'PENDING',
            logs: [{ attempt: 0, status: 0, response: 'Ingested', timestamp: new Date() }]
        });

        await eventDoc.save();

        logger.info({ traceId, dbId: generatedDbId.toString() }, 'Event persisted');

        await addToQueue({
            url: jobData.url,
            payload: payloadString,
            dbId: generatedDbId,
            traceId,
            source: 'API_KEY_USER',
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED',
        });

        enqueueJobUpdate({ id: generatedDbId, status: 'Pending', data: redact(jobData), traceId });

        res.status(202).json({
            status: 'accepted',
            message: 'Job pushed to queue',
            id: generatedDbId,
            traceId
        });

    } catch (error) {
        // E11000 = duplicate idempotencyKey
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
};

// ── Replay (POST /api/events/:id/replay) ──
exports.replayEvent = async (req, res) => {
    const enqueueJobUpdate = getEnqueueFn(req);

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid event ID' });
        }

        const eventLog = await Event.findById(req.params.id);
        if (!eventLog) {
            return res.status(404).json({ error: 'Event not found' });
        }

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

        // Try to remove the old BullMQ job — for DEAD events it's already
        // gone, for FAILED events it might still be managed by BullMQ
        const existingJob = await myQueue.getJob(jobId);
        if (existingJob) {
            try { await existingJob.remove(); } catch (_) {
                logger.warn({ jobId }, 'Could not remove existing BullMQ job for replay');
            }
        }

        // Use a unique replay job ID to avoid "job already exists" conflicts
        const replayJobId = existingJob ? `${jobId}-replay-${Date.now()}` : jobId;

        await myQueue.add('webhook-job', {
            url: eventLog.url,
            payload: typeof eventLog.payload === 'object' ? JSON.stringify(eventLog.payload) : eventLog.payload,
            dbId: eventLog._id,
            traceId: eventLog.traceId,
            deliverySemantics: eventLog.deliverySemantics
        }, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            jobId: replayJobId,
            removeOnComplete: { count: 200 },
            removeOnFail: false
        });

        enqueueJobUpdate({ id: eventLog._id, status: 'Pending (Replay)', data: redactPayloadString(eventLog.payload) });

        res.json({ message: 'Replay started', id: eventLog._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// ── Patch (PATCH /api/events/:id) ──
exports.patchEvent = async (req, res) => {
    const enqueueJobUpdate = getEnqueueFn(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid event ID format', code: 'INVALID_ID' });
    }

    const updateMask = req.query.updateMask || req.headers['x-update-mask'];
    const updateData = req.body;

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
            status: 'Updated',
            response: `Patched fields: ${Object.keys(safeUpdates).join(', ')}`
        });

        res.json({ message: 'Event updated successfully', updatedFields: Object.keys(safeUpdates) });

    } catch (error) {
        if (error.code === 'INVALID_FIELD_MASK') {
            return res.status(400).json({
                error: 'Bad Request',
                message: error.message,
                code: error.code
            });
        }
        res.status(500).json({ error: error.message });
    }
};

// ── List events (GET /api/events) ──
exports.getEvents = async (req, res) => {
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
};

// ── Get single event (GET /api/events/:id) ──
exports.getEventById = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid event ID format', code: 'INVALID_ID' });
        }

        const event = await Event.findById(req.params.id).lean();
        if (!event) return res.status(404).json({ error: 'Event not found' });

        res.json({
            ...event,
            payload: event.payload ? redactPayloadString(event.payload) : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// ── Delete event (DELETE /api/events/:id) ──
exports.deleteEvent = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid event ID format', code: 'INVALID_ID' });
        }

        const result = await Event.findByIdAndDelete(req.params.id);
        if (!result) return res.status(404).json({ error: 'Event not found' });
        res.json({ message: 'Event deleted', id: req.params.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
