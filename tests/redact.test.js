// tests/redact.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { redact, redactPayloadString, REDACTED } = require('../src/utils/redact');

describe('redact — sensitive key scrubbing', () => {
    test('redacts password field', () => {
        const result = redact({ password: 'secret123', name: 'Alice' });
        assert.strictEqual(result.password, REDACTED);
        assert.strictEqual(result.name, 'Alice');
    });

    test('redacts all known sensitive keys', () => {
        const input = {
            password: 'x', passwd: 'x', pass: 'x',
            secret: 'x', token: 'x', auth: 'x',
            authorization: 'x', cookie: 'x',
            email: 'x', ssn: 'x', cvv: 'x', cvc: 'x',
            creditcard: 'x', credit_card: 'x',
            cardnumber: 'x', card_number: 'x',
            apikey: 'x', api_key: 'x',
            private_key: 'x', privatekey: 'x',
            access_token: 'x', refresh_token: 'x',
        };
        const result = redact(input);
        for (const key of Object.keys(input)) {
            assert.strictEqual(result[key], REDACTED, `${key} should be redacted`);
        }
    });

    test('case-insensitive key matching', () => {
        const result = redact({ Password: 'x', TOKEN: 'x', Email: 'x' });
        assert.strictEqual(result.Password, REDACTED);
        assert.strictEqual(result.TOKEN, REDACTED);
        assert.strictEqual(result.Email, REDACTED);
    });

    test('redacts nested objects recursively', () => {
        const result = redact({
            user: { name: 'Alice', password: 'secret' },
            safe: 'value',
        });
        assert.strictEqual(result.user.password, REDACTED);
        assert.strictEqual(result.user.name, 'Alice');
        assert.strictEqual(result.safe, 'value');
    });

    test('redacts objects inside arrays', () => {
        const result = redact([
            { name: 'Alice', token: 'abc' },
            { name: 'Bob', token: 'xyz' },
        ]);
        assert.strictEqual(result[0].token, REDACTED);
        assert.strictEqual(result[1].token, REDACTED);
        assert.strictEqual(result[0].name, 'Alice');
    });

    test('maxDepth cap returns REDACTED for deeply nested objects', () => {
        const deep = { a: { b: { c: { d: { e: { f: 'value' } } } } } };
        const result = redact(deep, 3);
        assert.strictEqual(result.a.b.c, REDACTED);
    });

    test('does not mutate the original input', () => {
        const input = { password: 'secret', name: 'Alice' };
        const inputCopy = JSON.parse(JSON.stringify(input));
        redact(input);
        assert.deepStrictEqual(input, inputCopy);
    });

    test('null/undefined/primitives pass through unchanged', () => {
        assert.strictEqual(redact(null), null);
        assert.strictEqual(redact(undefined), undefined);
        assert.strictEqual(redact(42), 42);
        assert.strictEqual(redact('hello'), 'hello');
    });
});

describe('redactPayloadString', () => {
    test('valid JSON string is parsed, redacted, and re-stringified', () => {
        const input = JSON.stringify({ password: 'secret', name: 'Alice' });
        const result = redactPayloadString(input);
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.password, REDACTED);
        assert.strictEqual(parsed.name, 'Alice');
    });

    test('invalid JSON string returns unchanged', () => {
        const input = 'not valid json {{{';
        assert.strictEqual(redactPayloadString(input), input);
    });

    test('non-string input returns unchanged', () => {
        assert.strictEqual(redactPayloadString(42), 42);
        assert.strictEqual(redactPayloadString(null), null);
        assert.strictEqual(redactPayloadString(undefined), undefined);
    });
});
