// src/models/Event.js
const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
    // --- 🔍 OBSERVABILITY (New) ---
    // The "Digital Thread" to track this request across the entire system
    traceId: { 
        type: String, 
        required: true, 
        index: true 
    },

    // --- 📜 CONTRACT (New) ---
    // Explicitly stating our architectural trade-off: 
    // "We guarantee delivery, but NOT order."
    deliverySemantics: { 
        type: String, 
        default: 'AT_LEAST_ONCE_UNORDERED',
        immutable: true 
    },

    // --- CORE DATA ---
    source: { type: String, default: 'API' }, // Defaulted to API if not sent
    payload: { type: Object, required: true },
    url: { type: String, required: true },    // ⚠️ Renamed from 'targetUrl' to match worker.js
    
    // --- STATE MACHINE ---
    status: { 
        type: String, 
        enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'FAILED_PERMANENT', 'DEAD'], 
        default: 'PENDING' 
    },

    // --- FAILURE HANDLING ---
    failureType: { 
        type: String, 
        enum: ['TRANSIENT', 'PERMANENT', null], 
        default: null 
    },
    finalHttpStatus: Number,
    attemptCount: { type: Number, default: 0 },
    lastError: String,

    // --- LOGS ---
    logs: [{
        attempt: Number,
        status: Number,
        response: String,
        timestamp: { type: Date, default: Date.now }
    }]
}, { 
    timestamps: true // Automatically manages createdAt and updatedAt
});

module.exports = mongoose.model('Event', EventSchema);