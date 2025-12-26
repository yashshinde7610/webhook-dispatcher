// mock.js - The "Always Success" Server
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'OK' }));
}).listen(8000, () => console.log('✅ Mock Target running on port 8000'));