const crypto = require('crypto');
const mongoose = require('mongoose');
const Joi = require('joi');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const Event = require('../../models/Event');
const redis = require('../../redis');
const logger = require('../../utils/logger');
const { redact, redactPayloadString } = require('../../utils/redact');
const { applyFieldMask } = require('../../utils/fieldMask');
const { addToQueue, myQueue } = require('../../queue');

// Validation schemas
const eventSchema = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https'] }).required()
        .messages({ 'string.uri': 'url must be a valid HTTP/HTTPS URL' }),
    payload: Joi.object().required()
        .messages({ 'any.required': 'payload is required and must be a JSON object' })
}).options({ allowUnknown: true });

const patchSchema = Joi.object({
    status: Joi.string().valid('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'FAILED_PERMANENT', 'DEAD'),
    url: Joi.string().uri({ scheme: ['http', 'https'] }),
    payload: Joi.object(),
    failureType: Joi.string().valid('TRANSIENT', 'PERMANENT').allow(null),
    lastError: Joi.string().allow(null, ''),
}).options({ stripUnknown: true });

module.exports = (enqueueJobUpdate) => ({
    ingestEvent: async (req, res) => {
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

        const payloadString = JSON.stringify(jobData.payload);

        try {
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

            const generatedDbId = new mongoose.Types.ObjectId();

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

            await addToQueue({
                url: jobData.url,
                payload: payloadString,
                dbId: generatedDbId,
                traceId,
                source: 'API_KEY_USER',
                deliverySemantics: 'AT_LEAST_ONCE_UNORDERED'
            });

            enqueueJobUpdate({ id: generatedDbId, status: 'Pending', data: redact(jobData), traceId });

            res.status(202).json({
                status: 'accepted',
                message: 'Job pushed to queue',
                id: generatedDbId,
                traceId
            });

        } catch (error) {
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
    },

    replayEvent: async (req, res) => {
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
            const existingJob = await myQueue.getJob(jobId);
            if (existingJob) {
                try { await existingJob.remove(); } catch (_) {
                    logger.warn({ jobId }, 'Could not remove existing BullMQ job for replay');
                }
            }

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
                removeOnComplete: true,
                removeOnFail: false
            });

            enqueueJobUpdate({ id: eventLog._id, status: 'Pending (Replay)', data: redactPayloadString(eventLog.payload) });

            res.json({ message: 'Replay started', id: eventLog._id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    },

    patchEvent: async (req, res) => {
        const { id } = req.params;
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
                status: safeUpdates.status || 'Updated',
                response: `Patched fields: ${Object.keys(safeUpdates).join(', ')}`
            });

            res.json({ message: 'Event updated successfully', updatedFields: Object.keys(safeUpdates) });

        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    },

    suggestFix: async (req, res) => {
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) {
            return res.status(501).json({
                error: 'AI suggestions are not configured',
                message: 'Set GEMINI_API_KEY in your environment to enable this feature.',
                code: 'GEMINI_NOT_CONFIGURED'
            });
        }

        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ error: 'Invalid event ID format', code: 'INVALID_ID' });
            }

            const event = await Event.findById(req.params.id).lean();
            if (!event) return res.status(404).json({ error: 'Event not found', code: 'NOT_FOUND' });

            const failedStatuses = ['FAILED', 'FAILED_PERMANENT', 'DEAD'];
            if (!failedStatuses.includes(event.status)) {
                return res.status(400).json({
                    error: 'Event is not in a failed state',
                    message: `Current status: ${event.status}. AI suggestions are only available for failed webhooks.`,
                    code: 'NOT_FAILED'
                });
            }

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
1. Return ONLY a valid JSON object with keys: "analysis", "suggestion", "fixedPayload", "confidence"
2. confidence must be "high", "medium", or "low"
3. If the error is infrastructure-related and the payload looks correct, return the original payload unchanged with confidence "low"
4. Do NOT invent fields that weren't in the original payload
5. Keep the fixedPayload structure identical to the original`;

            const genAI = new GoogleGenerativeAI(geminiKey);
            const primaryModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
            const fallbackModel = 'gemini-2.0-flash-lite';

            let responseText;
            try {
                const model = genAI.getGenerativeModel({ model: primaryModel });
                const result = await model.generateContent(prompt);
                responseText = result.response.text();
            } catch (primaryErr) {
                if (primaryErr.message && primaryErr.message.includes('429') && primaryModel !== fallbackModel) {
                    logger.warn({ eventId: req.params.id }, 'Primary model rate-limited, trying fallback');
                    try {
                        const fbModel = genAI.getGenerativeModel({ model: fallbackModel });
                        const fbResult = await fbModel.generateContent(prompt);
                        responseText = fbResult.response.text();
                    } catch (fbErr) {
                        const isQuota = fbErr.message && (fbErr.message.includes('429') || fbErr.message.includes('quota'));
                        return res.status(isQuota ? 429 : 502).json({
                            error: 'AI service temporarily unavailable',
                            message: isQuota ? 'Gemini API quota exceeded.' : fbErr.message,
                            code: isQuota ? 'QUOTA_EXCEEDED' : 'AI_ERROR'
                        });
                    }
                } else {
                    const isQuota = primaryErr.message && (primaryErr.message.includes('429') || primaryErr.message.includes('quota'));
                    return res.status(isQuota ? 429 : 502).json({
                        error: isQuota ? 'AI service temporarily unavailable' : 'AI request failed',
                        message: isQuota ? 'Gemini API quota exceeded.' : primaryErr.message,
                        code: isQuota ? 'QUOTA_EXCEEDED' : 'AI_ERROR'
                    });
                }
            }

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
    },

    getEvents: async (req, res) => {
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
    },

    getEventById: async (req, res) => {
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
    },

    deleteEvent: async (req, res) => {
        try {
            const result = await Event.findByIdAndDelete(req.params.id);
            if (!result) return res.status(404).json({ error: 'Event not found' });
            res.json({ message: 'Event deleted', id: req.params.id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
});
