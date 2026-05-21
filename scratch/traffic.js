
require('dotenv').config();

const API_KEY = process.env.API_KEY || 'test-api-key-123';
const BASE_URL = 'http://localhost:3000/api/events';

const TARGETS = [
    { url: 'https://httpbin.org/status/200', name: 'Success (200)' },
    { url: 'https://httpbin.org/status/500', name: 'Server Error (500) - Transient' },
    { url: 'https://httpbin.org/status/404', name: 'Not Found (404) - Permanent' },
    { url: 'https://httpbin.org/status/429', name: 'Rate Limit (429) - Transient' },
    { url: 'http://10.255.255.1', name: 'Timeout/Dead - Transient' }, 
    { url: 'http://127.0.0.1/admin', name: 'SSRF Blocked - Permanent' }
];

async function sendRequest(target, i) {
    console.log(`Firing request ${i+1}: ${target.name}`);
    try {
        const res = await fetch(BASE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'x-idempotency-key': `traffic-gen-${Date.now()}-${i}`
            },
            body: JSON.stringify({
                url: target.url,
                payload: { test: true, index: i, type: target.name }
            })
        });
        if (!res.ok) {
            console.error(`  -> Failed to queue ${target.name}: HTTP ${res.status}`);
        }
    } catch (e) {
        console.error(`  -> Network error queuing ${target.name}:`, e.message);
    }
}

async function run() {
    console.log('Shooting 15 varied webhook requests to the API...');
    for (let i = 0; i < 15; i++) {
        const target = TARGETS[i % TARGETS.length];
        await sendRequest(target, i);
        // Sleep 300ms between requests so they pop up on dashboard nicely
        await new Promise(r => setTimeout(r, 300));
    }
    console.log('Finished shooting traffic!');
}

run();
