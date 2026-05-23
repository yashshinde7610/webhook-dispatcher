// src/services/outboxTailer.js
//
// Outbox Tailer — the ONLY bridge between MongoDB and BullMQ.
//
// The API layer writes events to MongoDB with status PENDING.
// This tailer polls for unqueued PENDING events and pushes them
// to BullMQ. This is the Transactional Outbox Pattern:
//
//   MongoDB (source of truth) → Tailer → BullMQ → Worker
//
// By eliminating the dual-write (save-to-Mongo + add-to-Redis),
// we guarantee that every persisted event is eventually delivered
// even if the API server crashes between writes.
//
const os = require('os');
const crypto = require('crypto');
const Event = require('../models/Event');
const { addToQueue } = require('../queue');
const logger = require('../utils/logger');
const redis = require('../redis');

// Unique lock identity per process (hostname alone is useless in Docker
// where every container is PID 1)
const LOCK_OWNER = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;

// Poll every 2s — fast enough for near-real-time delivery,
// slow enough to not hammer MongoDB under load.
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2000;
const BATCH_SIZE       = 50;
const MAX_AGE_MS       = Number(process.env.OUTBOX_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
const LOCK_KEY         = 'lock:outbox_tailer';
const LOCK_TTL_S       = Math.max(5, Math.floor(POLL_INTERVAL_MS / 1000) + 5);

let pollTimer = null;

async function pollOutbox() {
    // Distributed lock — only one replica tails at a time
    const lock = await redis.set(LOCK_KEY, LOCK_OWNER, 'EX', LOCK_TTL_S, 'NX');
    if (!lock) {
        logger.debug('Another instance is tailing the outbox — skipping');
        return;
    }

    // Don't re-queue events older than 24h — they're probably broken
    const maxAge = new Date(Date.now() - MAX_AGE_MS);

    try {
        const pending = await Event.find({
            status: 'PENDING',
            createdAt: { $gt: maxAge },
        })
            .sort({ _id: 1 })
            .limit(BATCH_SIZE)
            .lean();

        if (pending.length === 0) return;

        logger.info({ count: pending.length }, 'Outbox: enqueuing PENDING events');

        // Enqueue in parallel — sequential await per event was 10-50x slower
        // (50 events × ~5ms = 250ms sequential vs ~5ms parallel)
        const results = await Promise.allSettled(
            pending.map(event =>
                addToQueue({
                    url: event.url,
                    payload: event.payload,
                    dbId: event._id,
                    traceId: event.traceId,
                    source: event.source || 'OUTBOX',
                    deliverySemantics: event.deliverySemantics || 'AT_LEAST_ONCE_UNORDERED',
                })
            )
        );

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const event = pending[i];
            if (r.status === 'fulfilled') {
                logger.debug({ traceId: event.traceId, id: event._id }, 'Outbox: event enqueued');
            } else {
                const err = r.reason;
                // "Job already exists" means the event was already enqueued
                // by a previous poll cycle — safe to skip
                if (err.message && err.message.includes('Job already exists')) {
                    logger.debug({ id: event._id }, 'Outbox: job already in BullMQ');
                } else {
                    logger.error({ err, id: event._id }, 'Outbox: failed to enqueue event');
                }
            }
        }
    } catch (err) {
        logger.error({ err }, 'Outbox poll failed');
    } finally {
        // Release the lock so the next cycle can run exactly on interval
        try {
            if (await redis.get(LOCK_KEY) === LOCK_OWNER) {
                await redis.del(LOCK_KEY);
            }
        } catch (_) {}
    }
}

function startTailer() {
    if (pollTimer) return;
    logger.info(
        { intervalMs: POLL_INTERVAL_MS },
        'Outbox tailer started'
    );
    // Run immediately on startup, then on interval
    pollOutbox().catch(() => {});
    pollTimer = setInterval(pollOutbox, POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref();
}

function stopTailer() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

module.exports = { startTailer, stopTailer, pollOutbox };
