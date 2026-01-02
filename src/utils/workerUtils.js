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
/*
 * Creates an HMAC signature for the webhook payload.
 */
function createHmacSignature(payload, secret) {
    if (!secret) throw new Error('❌ WEBHOOK_SECRET is missing in .env file');
    return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
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