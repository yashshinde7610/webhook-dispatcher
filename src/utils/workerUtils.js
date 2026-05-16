// src/utils/workerUtils.js
const crypto = require('crypto');

/**
 * Safely coerces an HTTP status code to a number (or null if garbage).
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
 * HMAC-SHA256 of the raw payload string.
 *
 * Important: this takes a *string*, not a parsed object. The payload
 * flows as a string from MongoDB → BullMQ → Axios (with transformRequest
 * identity to prevent re-serialization). This guarantees the receiver
 * can verify the signature against the exact bytes on the wire.
 */
function createHmacSignature(payloadString, secret) {
    if (!secret) throw new Error('WEBHOOK_SECRET is not set');
    if (typeof payloadString !== 'string') {
        payloadString = JSON.stringify(payloadString);
    }
    return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

/**
 * Classify a delivery error as retryable or permanent.
 * BullMQ only retries if we re-throw, so permanent errors
 * need to be caught and handled differently.
 */
function classifyError(error) {
    if (error.message === 'Circuit Breaker Open') return 'TRANSIENT';
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'|| error.code === 'ECONNREFUSED') return 'TRANSIENT';

    if (error.response) {
        const status = error.response.status;
        if (status === 429 || status >= 500) return 'TRANSIENT';
        if (status >= 400) return 'PERMANENT';
    }

    // Network blips (DNS failures, etc.) — worth retrying
    return 'TRANSIENT';
}

module.exports = {
    safeHttpStatus,
    createHmacSignature,
    classifyError
};