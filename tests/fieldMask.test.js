// tests/fieldMask.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { applyFieldMask } = require('../src/utils/fieldMask');

describe('Field Mask', () => {

    test('should only include fields listed in the mask', () => {
        const result = applyFieldMask(
            { id: 1, name: 'Alice', role: 'Admin' },
            'name,role'
        );
        assert.deepStrictEqual(result, { name: 'Alice', role: 'Admin' });
    });

    test('should strip fields not in the mask (prevents mass assignment)', () => {
        const result = applyFieldMask(
            { id: 1, password: 'secret', isAdmin: true },
            'id'
        );
        assert.deepStrictEqual(result, { id: 1 });
        assert.strictEqual(result.password, undefined);
    });

    test('should return empty object for wildcard or missing mask', () => {
        assert.deepStrictEqual(applyFieldMask({ a: 1 }, '*'), {});
        assert.deepStrictEqual(applyFieldMask({ a: 1 }, ''), {});
        assert.deepStrictEqual(applyFieldMask({ a: 1 }, null), {});
    });

    test('should handle mask fields that dont exist in the data', () => {
        const result = applyFieldMask({ a: 1 }, 'b,c');
        assert.deepStrictEqual(result, {});
    });
});