// src/models/Event.js
const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
    traceId: {
        type: String,
        required: true,
        index: true
    },

    // Our delivery contract — we guarantee delivery but NOT order
    deliverySemantics: {
        type: String,
        default: 'AT_LEAST_ONCE_UNORDERED',
        immutable: true
    },

    source: { type: String, default: 'API' },

    // Stored as a string (not Object) to prevent NoSQL injection via
    // keys like "$gt" and to keep HMAC signatures consistent — the
    // worker signs the exact string stored here, no re-serialization.
    payload: { type: String, required: true },

    url: { type: String, required: true },

    // Unique sparse index: only indexed when present, gives us atomic
    // deduplication via E11000 without wasting Redis RAM.
    idempotencyKey: {
        type: String,
        index: { unique: true, sparse: true }
    },

    status: {
        type: String,
        enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'FAILED_PERMANENT', 'DEAD'],
        default: 'PENDING'
    },

    failureType: {
        type: String,
        enum: ['TRANSIENT', 'PERMANENT', null],
        default: null
    },
    finalHttpStatus: Number,
    attemptCount: { type: Number, default: 0 },
    lastError: String,
    errorCode: String,

    // Capped at MAX_LOGS to stay well under MongoDB's 16MB doc limit
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
    timestamps: true
});

// Auto-delete events after 30 days. Also frees up idempotency keys.
const TTL_SECONDS = Number(process.env.EVENT_TTL_SECONDS) || 30 * 24 * 60 * 60;
EventSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

EventSchema.statics.MAX_LOGS = 20;
EventSchema.statics.TTL_SECONDS = TTL_SECONDS;

module.exports = mongoose.model('Event', EventSchema);