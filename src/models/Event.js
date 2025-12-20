// src/models/Event.js
const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
    // Security: Who sent this?
    source: { type: String, required: true }, // e.g., "API_KEY_...123"
    
    // The Payload
    payload: { type: Object, required: true },
    targetUrl: { type: String, required: true },

    // The State Machine
    status: { 
        type: String, 
        enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD'], 
        default: 'PENDING' 
    },

    // Observability: Track every single attempt
    logs: [{
        attempt: Number,
        status: Number, // HTTP Status (200, 404, 500)
        response: String,
        timestamp: { type: Date, default: Date.now }
    }],

    // Timestamps
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Event', EventSchema);