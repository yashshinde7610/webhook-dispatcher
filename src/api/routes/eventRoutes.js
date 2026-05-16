const express = require('express');
const eventControllerFactory = require('../controllers/eventController');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../../redis');

module.exports = (enqueueJobUpdate) => {
    const router = express.Router();
    const eventController = eventControllerFactory(enqueueJobUpdate);

    // Rate limiting (Redis-backed, shared across replicas)
    const ingestLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: Number(process.env.RATE_LIMIT_RPM) || 1000,
        standardHeaders: true,
        legacyHeaders: false,
        store: new RedisStore({
            sendCommand: (...args) => redis.call(...args),
        }),
        message: { error: 'Too Many Requests', code: 'RATE_LIMITED' },
    });

    router.post('/', ingestLimiter, eventController.ingestEvent);
    router.post('/:id/replay', eventController.replayEvent);
    router.patch('/:id', eventController.patchEvent);
    router.post('/:id/suggest-fix', eventController.suggestFix);
    router.get('/', eventController.getEvents);
    router.get('/:id', eventController.getEventById);
    router.delete('/:id', eventController.deleteEvent);

    return router;
};
