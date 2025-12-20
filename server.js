// server.js
require('dotenv').config();
const express = require('express');
const http = require('http'); // New: Required for WebSockets
const { Server } = require('socket.io'); // New: The WebSocket Library
const { addToQueue } = require('./src/queue');
const { QueueEvents } = require('bullmq'); // New: To spy on the queue

const app = express();
const server = http.createServer(app); // Wrap Express
const io = new Server(server); // Attach Socket.io to the server

app.use(express.json());
app.use(express.static('public')); // Serve the dashboard file (we will create this next)

// --- QUEUE LISTENER (The Spy) ---
// This listens to Redis for job updates from the Worker
const queueEvents = new QueueEvents('webhook-queue', {
    connection: { host: '127.0.0.1', port: 6379 }
});

queueEvents.on('completed', ({ jobId }) => {
    console.log(`⚡ Event: Job ${jobId} completed!`);
    io.emit('job-update', { id: jobId, status: 'Completed', timestamp: new Date() });
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
    console.log(`⚡ Event: Job ${jobId} failed!`);
    io.emit('job-update', { id: jobId, status: 'Failed', reason: failedReason });
});

// --- SECURITY MIDDLEWARE ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({ error: '⛔ Access Denied: Invalid API Key' });
    }
    next();
};

// --- API ROUTE ---
app.post('/api/events', validateApiKey, async (req, res) => {
    try {
        const jobData = req.body;
        await addToQueue(jobData);
        
        // Notify the frontend immediately that a job was added
        io.emit('job-update', { id: 'New', status: 'Pending', data: jobData });
        
        res.status(202).json({ status: 'accepted', message: 'Job pushed to queue' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
// Note: We use 'server.listen', not 'app.listen'
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} 🚀 (WebSockets Ready)`);
});