// src/db.js
const mongoose = require('mongoose');

// Docker maps internal port 27017 to localhost:27017
const MONGO_URI = 'mongodb://127.0.0.1:27017/webhook-dispatcher';

async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('📦 MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Failed:', error);
        process.exit(1);
    }
}

module.exports = connectDB;