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
    // Capped at MAX_LOGS entries to prevent unbounded document growth.
    // MongoDB has a hard 16 MB document limit, and large arrays cause
    // costly document migrations on disk.  Even though retries are set
    // to 5 today, a bug or config change could loop — this is the
    // defense-in-depth safety net.
    logs: {
        type: [{
            attempt: Number,
            status: Number,
            response: String,
            timestamp: { type: Date, default: Date.now }
        }],
        validate: {
            validator: (arr) => arr.length <= 20,
            message: 'logs array exceeds the maximum allowed length of 20'
        },
        default: []
    }
}, { 
    timestamps: true // Automatically manages createdAt and updatedAt
});

// Export the cap so the write layer can reference the same constant.
EventSchema.statics.MAX_LOGS = 20;

module.exports = mongoose.model('Event', EventSchema);