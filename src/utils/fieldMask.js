// src/utils/fieldMask.js

/**
 * Filters an update payload to only include fields listed in the mask.
 * If no mask is provided, returns empty — we don't allow blind updates.
 */
function applyFieldMask(data, maskString) {
    if (!maskString || maskString === '*') {
        const err = new Error('updateMask is required and cannot be wildcard (*)');
        err.code = 'INVALID_FIELD_MASK';
        throw err;
    }

    const allowedFields = maskString.split(',').map(f => f.trim());
    const sanitizedUpdate = {};

    allowedFields.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(data, field)) {
            sanitizedUpdate[field] = data[field];
        }
    });

    return sanitizedUpdate;
}

module.exports = { applyFieldMask };