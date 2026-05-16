// src/utils/redact.js
//
// Scrubs known-sensitive keys (passwords, tokens, emails, etc.) from
// objects before they're sent to the dashboard or written to logs.
// The raw payload in MongoDB is intentionally NOT redacted — the
// worker needs the original data to deliver the webhook.

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
 * Caps recursion depth to avoid stack overflow on weird payloads.
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
 * Parse a JSON string, redact it, re-stringify. Returns the original
 * string unchanged if parsing fails.
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
