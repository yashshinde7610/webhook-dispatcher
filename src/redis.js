// src/redis.js
require('dotenv').config();
const Redis = require('ioredis');

const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null // required by BullMQ
});

redis.on('connect', () => {
    console.log(`Redis connected at ${redis.options.host}:${redis.options.port}`);
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err.message);
});

module.exports = redis;