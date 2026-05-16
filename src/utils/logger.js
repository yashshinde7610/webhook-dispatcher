// src/utils/logger.js
//
// Pino async logger — replaces console.log/error which block the event
// loop at high throughput. In production, pipe output to a log aggregator.
// In dev, pino-pretty gives you human-readable formatting.
//
const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

    // Redact sensitive fields at the serialization layer so they
    // never accidentally end up in log files or error responses.
    redact: {
        paths: [
            'payload',
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

    timestamp: pino.stdTimeFunctions.isoTime,

    // Pretty-print in dev, raw JSON in prod
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
