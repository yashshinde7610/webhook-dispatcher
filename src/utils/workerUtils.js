// src/utils/workerUtils.js
const crypto = require('crypto');


/**
 * Safely parses an HTTP status code from numbers or strings.
 * Returns null if invalid.
 */
function safeHttpStatus(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val.trim() !== '') {
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Creates an HMAC-SHA256 signature for the webhook payload.
 *
 * ARCHITECTURE: Accepts a raw JSON **string**, NOT a parsed object.
 * The payload is stored as a string in MongoDB and flows through BullMQ
 * as a string.  The worker signs this exact string and sends it on the
 * wire via Axios (with transformRequest identity to prevent re-serialization).
 * This guarantees:  HMAC(stored) === HMAC(sent) === HMAC(received)
 *
 * The old approach (json-stable-stringify on a parsed object) broke strict
 * webhook receivers (Stripe, GitHub, Slack) because it re-formatted the
 * payload, producing a hash that never matched the raw bytes on the wire.
 */
function createHmacSignature(payloadString, secret) {
    if (!secret) throw new Error('❌ WEBHOOK_SECRET is missing in .env file');
    if (typeof payloadString !== 'string') {
        // Backward compat: if an old-format Object sneaks through, stringify it
        payloadString = JSON.stringify(payloadString);
    }
    return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

/**
 * Classifies an error as TRANSIENT (retryable) or PERMANENT (fatal).
 */
function classifyError(error) {
    if (error.message === 'Circuit Breaker Open') return 'TRANSIENT';
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'|| error.code === 'ECONNREFUSED') return 'TRANSIENT';
    
    // If we have a response, check the status code
    if (error.response) {
        const status = error.response.status;
        if (status === 429 || status >= 500) return 'TRANSIENT'; 
        if (status >= 400) return 'PERMANENT'; 
    }
    
    // Default to transient for network blips (e.g., DNS failures)
    return 'TRANSIENT'; 
}

module.exports = {
    safeHttpStatus,
    createHmacSignature,
    classifyError
};