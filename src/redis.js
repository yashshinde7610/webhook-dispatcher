// src/redis.js
require('dotenv').config();
const Redis = require('ioredis');

// Docker passes "redis" as the host. Localhost is the fallback.
const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null
};

const redis = new Redis(redisConfig);

redis.on('connect', () => {
    // This log proves if we are using Docker ("redis") or Local ("127.0.0.1")
    console.log(`✅ Connected to Redis at ${redisConfig.host}:${redisConfig.port}`);
});

redis.on('error', (err) => {
    console.error('❌ Redis Connection Error:', err);
});

module.exports = redis;