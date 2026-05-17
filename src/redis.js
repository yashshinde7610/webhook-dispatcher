// src/redis.js
const Redis = require('ioredis');
const logger = require('./utils/logger');

const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null // required by BullMQ
});

redis.on('connect', () => {
    logger.info({ host: redis.options.host, port: redis.options.port }, 'Redis connected');
});

redis.on('error', (err) => {
    logger.error({ err: err.message }, 'Redis connection error');
});

module.exports = redis;