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

    // 🛡️ PAYLOAD AS STRING (NoSQL Injection Protection + HMAC Consistency)
    // Storing as a raw JSON string instead of Object prevents two critical flaws:
    //   1. NoSQL INJECTION: Keys like "$gt" or "user.name" (dots/dollars) would
    //      be interpreted as MongoDB operators or nested paths if stored as Object.
    //   2. HMAC MISMATCH: The worker must sign the *exact bytes* it sends.
    //      Storing as a string ensures sign(stored) === sign(sent) — no
    //      parse/re-serialize cycle that changes whitespace or key order.
    payload: { type: String, required: true },

    url: { type: String, required: true },    // ⚠️ Renamed from 'targetUrl' to match worker.js

    // --- IDEMPOTENCY (Disk-Backed) ---
    // Unique sparse index: only documents WITH this field are indexed.
    // E11000 on collision → instant atomic dedup without Redis RAM pressure.
    // Keys now live as long as the event (days/months/forever), not 5 minutes.
    idempotencyKey: {
        type: String,
        index: { unique: true, sparse: true }
    },
    
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

// --- 🛡️ TTL INDEX (Auto-Purge) ---
// MongoDB automatically deletes documents 30 days after `createdAt`.
// This prevents unbounded collection growth at scale and also solves the
// "forever-blocked idempotency key" problem: after 30 days the document
// (and its unique idempotencyKey) is cleaned up, freeing the key for reuse.
// 30 days = 2,592,000 seconds.  Adjust via Event.TTL_SECONDS if needed.
const TTL_SECONDS = Number(process.env.EVENT_TTL_SECONDS) || 30 * 24 * 60 * 60;
EventSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

// Export the cap so the write layer can reference the same constant.
EventSchema.statics.MAX_LOGS = 20;
EventSchema.statics.TTL_SECONDS = TTL_SECONDS;

module.exports = mongoose.model('Event', EventSchema);