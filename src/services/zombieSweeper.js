// src/services/zombieSweeper.js
//
// 🧹 ZOMBIE JOB SWEEPER (Outbox Pattern)
//
// PROBLEM (Dual-Write Vulnerability):
//   In server.js, we do: await eventDoc.save() → await addToQueue().
//   If MongoDB succeeds but Redis/BullMQ crashes before addToQueue(),
//   the Event doc sits in PENDING forever — a "zombie".  The idempotency
//   key is locked, and no retry will succeed (409 Conflict).
//
// THE FIX:
//   A background sweeper periodically scans for PENDING events whose
//   createdAt is older than ZOMBIE_THRESHOLD_MS.  If found, it assumes
//   the Redis write failed and pushes the job back onto the BullMQ queue.
//   This is the "Outbox Pattern" — MongoDB is the source of truth, and
//   the sweeper ensures eventual delivery.
//
const Event = require('../models/Event');
const { addToQueue } = require('../queue');
const logger = require('../utils/logger');

const ZOMBIE_THRESHOLD_MS = Number(process.env.ZOMBIE_THRESHOLD_MS) || 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS   = Number(process.env.SWEEP_INTERVAL_MS)  || 60 * 1000;      // Every 1 minute
const SWEEP_BATCH_SIZE    = 50; // Process at most 50 zombies per sweep

let sweepTimer = null;

/**
 * Find PENDING events older than the threshold and re-queue them.
 * Uses _id-range pagination to avoid full collection scans.
 */
async function sweepZombies() {
    const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MS);

    try {
        // Find PENDING events created before the cutoff
        // The { status, createdAt } compound query is efficient because:
        //   - status is an enum with few distinct values
        //   - createdAt has a TTL index (already indexed)
        const zombies = await Event.find({
            status: 'PENDING',
            createdAt: { $lt: cutoff },
        })
            .sort({ _id: 1 })
            .limit(SWEEP_BATCH_SIZE)
            .lean();

        if (zombies.length === 0) return;

        logger.warn({ count: zombies.length }, 'Zombie sweeper found stale PENDING events');

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
                // BullMQ will throw if the jobId already exists (duplicate)
                // This is safe — it means the job was actually queued after all
                if (err.message && err.message.includes('Job already exists')) {
                    logger.debug({ id: zombie._id }, 'Zombie already has a BullMQ job — skipping');
                } else {
                    logger.error({ err, id: zombie._id }, 'Failed to re-queue zombie');
                }
            }
        }
    } catch (err) {
        logger.error({ err }, 'Zombie sweep failed');
    }
}

/**
 * Start the background sweeper.
 * Should be called once from server.js after DB connection is established.
 */
function startSweeper() {
    if (sweepTimer) return; // Already running
    logger.info(
        { intervalMs: SWEEP_INTERVAL_MS, thresholdMs: ZOMBIE_THRESHOLD_MS },
        'Zombie sweeper started'
    );
    sweepTimer = setInterval(sweepZombies, SWEEP_INTERVAL_MS);
    // Don't prevent process exit
    if (sweepTimer.unref) sweepTimer.unref();
}

/**
 * Stop the sweeper (for graceful shutdown).
 */
function stopSweeper() {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

module.exports = { startSweeper, stopSweeper, sweepZombies };
