// src/api/middleware.js
// Auth and rate limiting middleware used across API routes.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../redis');

// Constant-time comparison to prevent timing side-channel on API key checks.
// V8's === exits early on first byte mismatch, leaking key length/prefix.
//
// We HMAC both values through a random nonce so the comparison buffer
// is always 32 bytes regardless of input length. This prevents an
// attacker from deducing key length via response time differences.
function safeCompare(a, b) {
    const strA = String(a || '');
    const strB = String(b || '');
    const key = crypto.randomBytes(32);
    const hmacA = crypto.createHmac('sha256', key).update(strA).digest();
    const hmacB = crypto.createHmac('sha256', key).update(strB).digest();
    return crypto.timingSafeEqual(hmacA, hmacB);
}

function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!safeCompare(apiKey, process.env.API_KEY)) {
        return res.status(403).json({ error: 'Access Denied: Invalid API Key' });
    }
    next();
}

// Redis-backed rate limiter shared across replicas — tuned for
// high-throughput ingest (1000 RPM default)
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

// Stricter limiter for operator actions (replay, delete).
// Each replay enqueues a BullMQ job, so we cap at 20 RPM to prevent
// queue spam. Separate from ingestLimiter so ingest traffic can't
// exhaust the operator budget and vice versa.
const operatorLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.OPERATOR_RATE_LIMIT_RPM) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
        sendCommand: (...args) => redis.call(...args),
        prefix: 'rl:operator:',
    }),
    message: { error: 'Too Many Requests', code: 'OPERATOR_RATE_LIMITED' },
});

module.exports = { validateApiKey, ingestLimiter, operatorLimiter, safeCompare };

