// src/utils/ssrf.js
//
// SSRF protection utilities. Extracted from worker.js so they can be
// unit-tested without importing BullMQ/Mongoose side effects.
//
// Strategy: we can't just regex the hostname — things like
// 127.0.0.1.nip.io, octal IPs (0177.0.0.1), or DNS rebinding
// would bypass it. Instead: resolve via DNS, then check the actual
// IP against known private/reserved ranges.

const dns = require('dns');
const net = require('net');

/**
 * Returns true if the given IP address belongs to a private, reserved,
 * or otherwise non-routable range. Fail-closed: unknown formats → true.
 */
function isPrivateIP(ip) {
    // Handle IPv4-mapped IPv6 like ::ffff:10.0.0.1
    if (ip.startsWith('::ffff:')) {
        ip = ip.slice(7);
    }

    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        const [a, b] = parts;

        if (a === 0)   return true;                          // current network
        if (a === 10)  return true;                          // RFC-1918
        if (a === 127) return true;                          // loopback
        if (a === 169 && b === 254) return true;             // link-local
        if (a === 172 && b >= 16 && b <= 31) return true;    // RFC-1918
        if (a === 192 && b === 168) return true;             // RFC-1918
        if (a === 100 && b >= 64 && b <= 127) return true;   // CGN / shared
        if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking

        return false;
    }

    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1') return true;                           // loopback
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
        // Link-local is fe80::/10 — covers fe80 through febf
        const first16 = parseInt(normalized.slice(0, 4), 16);
        if (!isNaN(first16) && (first16 & 0xffc0) === 0xfe80) return true;
        // Documentation prefix (RFC 3849) — no real endpoint lives here.
        // Allowing it risks exfiltration to test-only infrastructure.
        if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0db8:')) return true;
        return false;
    }

    // Unknown format — block it (fail-closed)
    return true;
}

/**
 * Resolve hostname via DNS and reject if the IP is private.
 * Returns the validated IP so we can pin Axios to it (prevents DNS rebinding).
 */
async function assertNotPrivate(hostname) {
    if (net.isIP(hostname)) {
        if (isPrivateIP(hostname)) {
            throw Object.assign(
                new Error(`SSRF Blocked: Target resolves to private IP: ${hostname}`),
                { ssrfBlocked: true }
            );
        }
        return hostname;
    }

    const { address } = await dns.promises.lookup(hostname);

    if (isPrivateIP(address)) {
        throw Object.assign(
            new Error(`SSRF Blocked: ${hostname} resolved to private IP ${address}`),
            { ssrfBlocked: true }
        );
    }

    return address;
}

module.exports = { isPrivateIP, assertNotPrivate };
