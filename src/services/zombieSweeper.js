// src/services/zombieSweeper.js
//
// Background sweeper for "zombie" events — PENDING docs in MongoDB
// that never made it to BullMQ (e.g. server crashed between the
// Mongo write and the Redis enqueue). This is basically the outbox
// pattern: MongoDB is the source of truth, and this sweeper ensures
// eventual delivery.
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

const ZOMBIE_THRESHOLD_MS = Number(process.env.ZOMBIE_THRESHOLD_MS) || 5 * 60 * 1000;
const SWEEP_INTERVAL_MS   = Number(process.env.SWEEP_INTERVAL_MS)  || 60 * 1000;
const SWEEP_BATCH_SIZE    = 50;
const ZOMBIE_MAX_AGE_MS   = Number(process.env.ZOMBIE_MAX_AGE_MS)  || 24 * 60 * 60 * 1000;
const LOCK_KEY            = 'lock:zombie_sweeper';
const LOCK_TTL_S          = Math.floor(SWEEP_INTERVAL_MS / 1000) - 10;

let sweepTimer = null;

async function sweepZombies() {
    // Distributed lock — only one replica sweeps at a time
    const lock = await redis.set(LOCK_KEY, LOCK_OWNER, 'EX', LOCK_TTL_S, 'NX');
    if (!lock) {
        logger.debug('Another instance is currently sweeping — skipping');
        return;
    }

    const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MS);
    // Don't re-queue events older than 24h — they're probably broken
    const maxAge = new Date(Date.now() - ZOMBIE_MAX_AGE_MS);

    try {
        const zombies = await Event.find({
            status: 'PENDING',
            createdAt: { $lt: cutoff, $gt: maxAge },
        })
            .sort({ _id: 1 })
            .limit(SWEEP_BATCH_SIZE)
            .lean();

        if (zombies.length === 0) return;

        logger.warn({ count: zombies.length }, 'Found stale PENDING events');

        for (const zombie of zombies) {
            try {
                await addToQueue({
                    url: zombie.url,
                    payload: zombie.payload,
                    dbId: zombie._id,
                    traceId: zombie.traceId,
                    source: zombie.source || 'SWEEPER',
                    deliverySemantics: zombie.deliverySemantics || 'AT_LEAST_ONCE_UNORDERED',
                });
                logger.info({ traceId: zombie.traceId, id: zombie._id }, 'Zombie re-queued');
            } catch (err) {
                // "Job already exists" just means it was actually queued — safe to skip
                if (err.message && err.message.includes('Job already exists')) {
                    logger.debug({ id: zombie._id }, 'Zombie already has a BullMQ job');
                } else {
                    logger.error({ err, id: zombie._id }, 'Failed to re-queue zombie');
                }
            }
        }
    } catch (err) {
        logger.error({ err }, 'Zombie sweep failed');
    }
}

function startSweeper() {
    if (sweepTimer) return;
    logger.info(
        { intervalMs: SWEEP_INTERVAL_MS, thresholdMs: ZOMBIE_THRESHOLD_MS },
        'Zombie sweeper started'
    );
    sweepTimer = setInterval(sweepZombies, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
}

function stopSweeper() {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

module.exports = { startSweeper, stopSweeper, sweepZombies };
