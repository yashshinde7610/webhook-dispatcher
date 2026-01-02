// tests/fieldMask.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { applyFieldMask } = require('../src/utils/fieldMask');

describe('Utility Logic Tests (applyFieldMask)', () => {

    // ✅ Test 1: Verify it allows listed fields
    test('Test 1 (Basic Filtering): Should only include fields specified in the mask', () => {
        const inputData = { id: 1, name: "Alice", role: "Admin" };
        const mask = "name,role";
        
        const result = applyFieldMask(inputData, mask);
        
        // We expect 'id' to be stripped out
        assert.deepStrictEqual(result, { name: "Alice", role: "Admin" });
    });

    // ✅ Test 2: Verify it blocks unlisted fields (Security)
    test('Test 2 (Security/Restriction): Should strictly exclude sensitive fields like password', () => {
        const inputData = { id: 1, password: "secret" };
        const mask = "id";
        
        const result = applyFieldMask(inputData, mask);
        
        // We expect 'password' to be stripped out
        assert.deepStrictEqual(result, { id: 1 });
    });

    // ✅ Test 3: Verify Edge Cases (Empty or Wildcard)
    test('Test 3 (Edge Case): Should return empty object for invalid or wildcard masks', () => {
        const inputData = { a: 1 };
        
        // Case A: Wildcard '*'
        const resultWildcard = applyFieldMask(inputData, '*');
        assert.deepStrictEqual(resultWildcard, {});

        // Case B: Empty String ''
        const resultEmpty = applyFieldMask(inputData, '');
        assert.deepStrictEqual(resultEmpty, {});
    });

});