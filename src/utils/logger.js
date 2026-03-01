// src/utils/logger.js
//
// 🛡️ HIGH-PERFORMANCE ASYNC LOGGER (Replaces console.log)
//
// PROBLEM: console.log/error write synchronously to stdout, blocking the
// single-threaded Node.js event loop.  At 5,000 req/s, formatting and
// printing terminal strings becomes a measurable bottleneck.
//
// THE FIX: Pino writes JSON to stdout asynchronously via a worker thread.
// In production, pipe output to a log aggregator (Datadog, ELK).
// In development, pipe through pino-pretty for human-readable formatting:
//   node server.js | npx pino-pretty
//
const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

    // 🛡️ PII REDACTION: Pino's built-in redaction replaces sensitive values
    // with "[Redacted]" at the serialization layer — zero-overhead, no
    // intermediate object copies, and impossible to forget.
    redact: {
        paths: [
            'payload',          // Webhook payloads may contain PII
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers.cookie',
            '*.password',
            '*.secret',
            '*.token',
            '*.email',
            '*.creditCard',
            '*.ssn',
        ],
        censor: '[REDACTED]',
    },

    // Format timestamps as ISO strings (default is epoch ms)
    timestamp: pino.stdTimeFunctions.isoTime,

    // Use pino-pretty transport in dev for human-readable output
    ...(!isProduction && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
            },
        },
    }),
});

module.exports = logger;
