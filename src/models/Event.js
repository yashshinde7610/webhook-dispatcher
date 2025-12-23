// src/models/Event.js
const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
    // --- EXISTING FIELDS ---
    source: { type: String, required: true },
    payload: { type: Object, required: true },
    targetUrl: { type: String, required: true },
    
    // --- UPDATED STATE MACHINE ---
    status: { 
        type: String, 
        // Added 'FAILED_PERMANENT' so we can distinguish "Dead" from "Retrying"
        enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'FAILED_PERMANENT','DEAD'], 
        default: 'PENDING' 
    },

    // --- NEW FIELDS (For Smart Retries) ---
    failureType: { 
        type: String, 
        enum: ['TRANSIENT', 'PERMANENT', null], // Is it a 500 (Retry) or 404 (Stop)?
        default: null 
    },
    finalHttpStatus: Number, // Stores the last status code (e.g., 404 or 500)
    attemptCount: { type: Number, default: 0 },
    lastError: String,       // Readable error message (e.g., "Connection Timeout")
    // ---------------------------------------

    // Observability (Keep this! It's great for history)
    logs: [{
        attempt: Number,
        status: Number,
        response: String,
        timestamp: { type: Date, default: Date.now }
    }],

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Event', EventSchema);