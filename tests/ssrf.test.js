// tests/ssrf.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── isPrivateIP tests: pure function, no mocking needed ──────
const { isPrivateIP } = require('../src/utils/ssrf');

describe('isPrivateIP — IPv4', () => {
    test('10.x.x.x (RFC-1918) is private', () => {
        assert.strictEqual(isPrivateIP('10.0.0.1'), true);
        assert.strictEqual(isPrivateIP('10.255.255.255'), true);
    });

    test('127.x.x.x (loopback) is private', () => {
        assert.strictEqual(isPrivateIP('127.0.0.1'), true);
        assert.strictEqual(isPrivateIP('127.255.255.255'), true);
    });

    test('172.16-31.x.x (RFC-1918) is private', () => {
        assert.strictEqual(isPrivateIP('172.16.0.1'), true);
        assert.strictEqual(isPrivateIP('172.31.255.255'), true);
    });

    test('172.32.0.1 is public (just outside RFC-1918 boundary)', () => {
        assert.strictEqual(isPrivateIP('172.32.0.1'), false);
    });

    test('192.168.x.x (RFC-1918) is private', () => {
        assert.strictEqual(isPrivateIP('192.168.1.1'), true);
        assert.strictEqual(isPrivateIP('192.168.0.0'), true);
    });

    test('169.254.x.x (link-local) is private', () => {
        assert.strictEqual(isPrivateIP('169.254.1.1'), true);
    });

    test('0.x.x.x (current network) is private', () => {
        assert.strictEqual(isPrivateIP('0.0.0.0'), true);
    });

    test('100.64-127.x.x (CGN / shared) is private', () => {
        assert.strictEqual(isPrivateIP('100.64.0.1'), true);
        assert.strictEqual(isPrivateIP('100.127.255.255'), true);
    });

    test('198.18-19.x.x (benchmarking) is private', () => {
        assert.strictEqual(isPrivateIP('198.18.0.1'), true);
        assert.strictEqual(isPrivateIP('198.19.255.255'), true);
    });

    test('public IPs return false', () => {
        assert.strictEqual(isPrivateIP('8.8.8.8'), false);
        assert.strictEqual(isPrivateIP('1.1.1.1'), false);
        assert.strictEqual(isPrivateIP('93.184.216.34'), false);
    });
});

describe('isPrivateIP — IPv6', () => {
    test('::1 (loopback) is private', () => {
        assert.strictEqual(isPrivateIP('::1'), true);
    });

    test('fc/fd (ULA) is private', () => {
        assert.strictEqual(isPrivateIP('fc00::1'), true);
        assert.strictEqual(isPrivateIP('fd12::1'), true);
    });

    test('fe80::/10 link-local range is private (bitmask covers fe80-febf)', () => {
        assert.strictEqual(isPrivateIP('fe80::1'), true);
        assert.strictEqual(isPrivateIP('feb0::1'), true);
        assert.strictEqual(isPrivateIP('fea0::1'), true);
        assert.strictEqual(isPrivateIP('febf::1'), true);
    });

    test('2001:db8::/32 (RFC 3849 documentation prefix) is blocked', () => {
        assert.strictEqual(isPrivateIP('2001:db8::1'), true);
        assert.strictEqual(isPrivateIP('2001:0db8::1'), true);
        assert.strictEqual(isPrivateIP('2001:db8:1::1'), true);
    });

    test('public IPv6 addresses return false', () => {
        assert.strictEqual(isPrivateIP('2606:4700::1'), false);
        assert.strictEqual(isPrivateIP('2001:4860::1'), false);
    });
});

describe('isPrivateIP — IPv4-mapped IPv6', () => {
    test('::ffff:10.0.0.1 maps to private IPv4', () => {
        assert.strictEqual(isPrivateIP('::ffff:10.0.0.1'), true);
    });

    test('::ffff:8.8.8.8 maps to public IPv4', () => {
        assert.strictEqual(isPrivateIP('::ffff:8.8.8.8'), false);
    });
});

describe('isPrivateIP — fail-closed', () => {
    test('unknown format returns true (blocked)', () => {
        assert.strictEqual(isPrivateIP('not-an-ip'), true);
        assert.strictEqual(isPrivateIP(''), true);
    });
});

// ── assertNotPrivate tests ───────────────────────────────────
// Raw IP passthrough (no DNS lookup needed) — net.isIP() returns truthy
describe('assertNotPrivate — raw IP passthrough', () => {
    // Import the function fresh (uses real dns, but we only pass raw IPs)
    const { assertNotPrivate } = require('../src/utils/ssrf');

    test('private IP throws with ssrfBlocked flag', async () => {
        await assert.rejects(
            () => assertNotPrivate('10.0.0.1'),
            (err) => {
                assert.strictEqual(err.ssrfBlocked, true);
                assert.ok(err.message.includes('SSRF Blocked'));
                return true;
            }
        );
    });

    test('public IP returns the IP string', async () => {
        const result = await assertNotPrivate('8.8.8.8');
        assert.strictEqual(result, '8.8.8.8');
    });
});

// Hostname resolution via DNS mock
describe('assertNotPrivate — DNS hostname resolution', () => {
    let assertNotPrivateDns;
    let mockAddress = '93.184.216.34';

    // Inject DNS mock before importing ssrf.js for this describe block
    const dnsPath = require.resolve('dns');
    const originalDns = require('dns');
    const ssrfPath = require.resolve('../src/utils/ssrf');

    // Clear ssrf from cache so it re-imports with our DNS mock
    delete require.cache[ssrfPath];

    require.cache[dnsPath] = {
        id: dnsPath,
        filename: dnsPath,
        loaded: true,
        exports: {
            ...originalDns,
            promises: {
                lookup: async (_hostname) => ({ address: mockAddress }),
            },
        },
    };

    assertNotPrivateDns = require('../src/utils/ssrf').assertNotPrivate;

    test('hostname resolving to private IP throws', async () => {
        mockAddress = '10.0.0.1';
        await assert.rejects(
            () => assertNotPrivateDns('evil.example.com'),
            (err) => {
                assert.strictEqual(err.ssrfBlocked, true);
                assert.ok(err.message.includes('resolved to private IP'));
                return true;
            }
        );
    });

    test('hostname resolving to public IP returns the address', async () => {
        mockAddress = '93.184.216.34';
        const result = await assertNotPrivateDns('example.com');
        assert.strictEqual(result, '93.184.216.34');
    });

    // Restore original dns module after tests
    require.cache[dnsPath] = {
        id: dnsPath,
        filename: dnsPath,
        loaded: true,
        exports: originalDns,
    };
});
