// src/db.js
const mongoose = require('mongoose');
const logger = require('./utils/logger');

// 🛡️ BOUNDED CONNECTION POOL: Mongoose defaults to 100 connections.
// If the API server is scaled to N replicas, each opens maxPoolSize
// connections → N×maxPoolSize total against MongoDB.  Cap explicitly
// to prevent exhausting managed DB tier limits.
const MONGO_POOL_SIZE = Number(process.env.MONGO_POOL_SIZE) || 20;

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(
            process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db',
            { maxPoolSize: MONGO_POOL_SIZE }
        );
        
        logger.info({ host: conn.connection.host, poolSize: MONGO_POOL_SIZE }, 'MongoDB connected');
    } catch (error) {
        logger.fatal({ err: error.message }, 'MongoDB connection failed');
        process.exit(1);
    }
};

module.exports = connectDB;