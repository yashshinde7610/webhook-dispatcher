// src/api/controllers/eventController.js
// Handles all /api/events endpoint logic.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Joi = require('joi');

const Event = require('../../models/Event');
const logger = require('../../utils/logger');
const { redact, redactPayloadString } = require('../../utils/redact');
const { myQueue } = require('../../queue');

// Validation schemas
const eventSchema = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https'] }).required()
        .messages({ 'string.uri': 'url must be a valid HTTP/HTTPS URL' }),
    payload: Joi.object().required()
        .messages({ 'any.required': 'payload is required and must be a JSON object' })
}).options({ stripUnknown: true });

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
// The API layer ONLY writes to MongoDB. The outbox tailer
// (src/services/outboxTailer.js) polls for PENDING events and
// pushes them to BullMQ. This eliminates the dual-write problem:
// a crash between Mongo save and Redis enqueue can never orphan a job.
exports.ingestEvent = async (req, res) => {
    const traceId = crypto.randomUUID();

    logger.info({ traceId }, 'Ingress: new request');

    const idempotencyKey = req.headers['idempotency-key'] || null;
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

    const jobData = req.body;

    // Serialize payload once at the boundary — this string flows through
    // MongoDB, BullMQ, HMAC signing, and Axios without re-serialization
    const payloadString = JSON.stringify(jobData.payload);

    try {
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

        // The outbox tailer will pick up this PENDING event and enqueue it
        res.status(202).json({
            status: 'accepted',
            message: 'Event accepted',
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
        res.status(500).json({ error: 'Internal Server Error', traceId });
    }
};

// ── Replay (POST /api/events/:id/replay) ──
exports.replayEvent = async (req, res) => {

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

        // Remove old BullMQ job so the outbox tailer can create a fresh one
        const jobId = eventLog._id.toString();
        const existingJob = await myQueue.getJob(jobId);
        if (existingJob) {
            try { await existingJob.remove(); } catch (_) {
                logger.warn({ jobId }, 'Could not remove existing BullMQ job for replay');
            }
        }

        // The outbox tailer will pick up this PENDING event and enqueue it
        res.json({ message: 'Replay started', id: eventLog._id });
    } catch (error) {
        logger.error({ err: error.message, id: req.params.id }, 'Replay error');
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// ── Patch (PATCH /api/events/:id) ──
exports.patchEvent = async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid event ID format', code: 'INVALID_ID' });
    }

    const updateData = req.body;

    const { error: patchValidationError, value: validatedBody } = patchSchema.validate(updateData);
    if (patchValidationError) {
        return res.status(400).json({
            error: 'Bad Request',
            message: patchValidationError.details[0].message,
            code: 'PATCH_VALIDATION_FAILED'
        });
    }

    logger.debug({ id, bodyKeys: Object.keys(validatedBody) }, 'PATCH request');

    try {
        const safeUpdates = { ...validatedBody };

        if (safeUpdates.payload && typeof safeUpdates.payload === 'object') {
            safeUpdates.payload = JSON.stringify(safeUpdates.payload);
        }

        if (Object.keys(safeUpdates).length === 0) {
            return res.status(400).json({
                error: 'No valid fields to update.',
                receivedBody: validatedBody
            });
        }

        logger.info({ id }, 'Updating event');

        const result = await Event.updateOne({ _id: id }, { $set: safeUpdates });

        if (result.matchedCount === 0) return res.status(404).json({ error: 'Event not found' });

        res.json({ message: 'Event updated successfully', updatedFields: Object.keys(safeUpdates) });

    } catch (error) {
        logger.error({ err: error.message, id }, 'Patch error');
        res.status(500).json({ error: 'Internal Server Error' });
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
        logger.error({ err: error.message }, 'List events error');
        res.status(500).json({ error: 'Internal Server Error' });
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
        logger.error({ err: error.message, id: req.params.id }, 'Get event error');
        res.status(500).json({ error: 'Internal Server Error' });
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

        // Remove from BullMQ if it's still pending/in-flight
        // Without this, the worker would still deliver the webhook!
        const existingJob = await myQueue.getJob(req.params.id);
        if (existingJob) {
            try { await existingJob.remove(); } catch (err) {
                logger.warn({ jobId: req.params.id, err: err.message }, 'Could not remove BullMQ job during deletion');
            }
        }

        res.json({ message: 'Event deleted', id: req.params.id });
    } catch (error) {
        logger.error({ err: error.message, id: req.params.id }, 'Delete event error');
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
