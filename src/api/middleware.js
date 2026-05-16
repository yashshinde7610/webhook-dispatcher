// src/api/middleware.js
// Auth and rate limiting middleware used across API routes.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../redis');

// Constant-time comparison to prevent timing side-channel on API key checks.
// V8's === exits early on first byte mismatch, leaking key length/prefix.
function safeCompare(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) {
        // Still burn a timingSafeEqual so the timing is consistent
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!safeCompare(apiKey, process.env.API_KEY)) {
        return res.status(403).json({ error: 'Access Denied: Invalid API Key' });
    }
    next();
}

// Redis-backed rate limiter shared across replicas
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

module.exports = { validateApiKey, ingestLimiter, safeCompare };
