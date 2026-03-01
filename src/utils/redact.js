// src/utils/redact.js
//
// 🛡️ PII / SENSITIVE DATA REDACTION
//
// Webhooks frequently carry PII (emails, auth tokens, financial data).
// This utility scrubs known-sensitive keys from objects before they are:
//   1. Emitted over WebSocket to the dashboard
//   2. Written to terminal/log output
//   3. Included in error responses
//
// IMPORTANT: This is a shallow-recursive scrubber for display purposes.
// The raw payload stored in MongoDB is intentionally NOT redacted — the
// worker needs the original data to deliver the webhook.  Redaction only
// applies to the "observation" layer (logs, dashboard, error messages).

const SENSITIVE_KEYS = new Set([
    'password', 'passwd', 'pass',
    'secret', 'token', 'auth',
    'authorization', 'cookie',
    'email', 'e-mail',
    'ssn', 'creditcard', 'credit_card',
    'cardnumber', 'card_number',
    'cvv', 'cvc',
    'apikey', 'api_key', 'api-key',
    'private_key', 'privatekey',
    'access_token', 'refresh_token',
    'x-api-key', 'x-signature',
]);

const REDACTED = '[REDACTED]';

/**
 * Deep-clone an object with sensitive keys replaced by "[REDACTED]".
 * Safe to call with any type — non-objects are returned as-is.
 *
 * @param {*} obj - The data to redact (usually a parsed payload or headers)
 * @param {number} [maxDepth=5] - Maximum recursion depth to prevent stack overflow
 * @returns {*} A new object with sensitive values replaced
 */
function redact(obj, maxDepth = 5) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (maxDepth <= 0) return REDACTED;

    if (Array.isArray(obj)) {
        return obj.map(item => redact(item, maxDepth - 1));
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
            result[key] = REDACTED;
        } else if (typeof value === 'object' && value !== null) {
            result[key] = redact(value, maxDepth - 1);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Redact a JSON string payload for display.
 * Parses → redacts → re-stringifies.  Returns the original string on parse error.
 */
function redactPayloadString(payloadString) {
    if (typeof payloadString !== 'string') return payloadString;
    try {
        const parsed = JSON.parse(payloadString);
        return JSON.stringify(redact(parsed));
    } catch {
        return payloadString;
    }
}

module.exports = { redact, redactPayloadString, REDACTED };
