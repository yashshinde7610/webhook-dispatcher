const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
}).listen(8000, () => console.log('🚀 Speed Target Ready on Port 8000'));