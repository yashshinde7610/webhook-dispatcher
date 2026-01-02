// mock.js - A simple dummy server to catch webhooks
const http = require('http');

const server = http.createServer((req, res) => {
    console.log('🔔 MOCK: Webhook Received!');
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        console.log('   📦 Payload:', body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    });
});

server.listen(8000, () => {
    console.log('🚀 Speed Target Ready on Port 8000');
});