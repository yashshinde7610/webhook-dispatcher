// src/db.js
const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        // 👇 UPDATED: Uses Docker Env Var OR Localhost fallback
        const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db');
        
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;