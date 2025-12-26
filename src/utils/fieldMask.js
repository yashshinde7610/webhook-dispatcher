// src/utils/fieldMask.js
/**
 * Applies a Field Mask to a payload.
 * Only fields listed in the mask will be included in the update.
 * @param {Object} data - The raw update data.
 * @param {String} maskString - Comma-separated list of fields (e.g., "status,payload.amount")
 * @returns {Object} - The sanitized update object ready for MongoDB $set
 */
function applyFieldMask(data, maskString) {
    // Safety: If no mask is provided, DO NOT allow the update.
    // This enforces the "Explicit Update" pattern.
    if (!maskString || maskString === '*') {
        return {}; 
    }

    const allowedFields = maskString.split(',').map(f => f.trim());
    const sanitizedUpdate = {};

    allowedFields.forEach(field => {
        // Only copy the field if it actually exists in the input data
        if (Object.prototype.hasOwnProperty.call(data, field)) {
            sanitizedUpdate[field] = data[field];
        }
    });

    return sanitizedUpdate;
}

module.exports = { applyFieldMask };