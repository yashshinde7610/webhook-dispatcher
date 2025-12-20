// server.js
const connectDB = require('./src/db');
connectDB(); // <--- Connects to Mongo immediately

require('dotenv').config();
const Event = require('./src/models/Event'); // Import the DB Model
const express = require('express');
const http = require('http'); // New: Required for WebSockets
const { Server } = require('socket.io'); // New: The WebSocket Library
const { addToQueue, myQueue } = require('./src/queue');
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

// --- API ROUTE (Day 7: Database Version) ---
app.post('/api/events', validateApiKey, async (req, res) => {
    try {
        const jobData = req.body;

        // 1. DATABASE: Create the record in MongoDB (Status: PENDING)
        // This is the "Paper Trail" for your resume
        const eventLog = new Event({
            source: 'API_KEY_USER', 
            payload: jobData,
            targetUrl: jobData.url,
            status: 'PENDING'
        });
        await eventLog.save(); // Saves to the database
        console.log(`💾 Job saved to DB. ID: ${eventLog._id}`);

        // 2. QUEUE: Pass the Database ID to the Worker
        // We add 'dbId' so the worker knows which record to update later
        await addToQueue({ 
            ...jobData, 
            dbId: eventLog._id 
        });
        
        // 3. REAL-TIME: Notify Frontend
        io.emit('job-update', { id: eventLog._id, status: 'Pending', data: jobData });
        
        res.status(202).json({ 
            status: 'accepted', 
            message: 'Job pushed to queue',
            id: eventLog._id 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ... (Your /api/events route is above here) ...

// --- PASTE THE NEW REPLAY ROUTE HERE ---
app.post('/api/events/:id/replay', validateApiKey, async (req, res) => {
    try {
        // 1. Find the original job in MongoDB
        const eventLog = await Event.findById(req.params.id);
        
        if (!eventLog) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // 2. Reset Status in Mongo
        eventLog.status = 'PENDING';
        eventLog.logs.push({ 
            attempt: eventLog.logs.length + 1, 
            status: 0, 
            response: 'Manual Replay Triggered' 
        });
        await eventLog.save();

        // 3. CLEAR REDIS: Remove the old failed job so we can reuse the ID
        const jobId = eventLog._id.toString();
        const existingJob = await myQueue.getJob(jobId);
        if (existingJob) {
            await existingJob.remove(); // 🗑️ Delete the old clogged job
        }

        // 4. Push back to Queue (Now Redis will accept it)
        await addToQueue({ 
            ...eventLog.payload, 
            dbId: eventLog._id 
        });

        // 5. Notify Frontend
        io.emit('job-update', { id: eventLog._id, status: 'Pending (Replay)', data: eventLog.payload });

        res.json({ message: 'Replay started', id: eventLog._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ... (const PORT = 3000 is below here) ...
// Note: We use 'server.listen', not 'app.listen'
const PORT = 3000; // <--- Add this line right before server.listen
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} 🚀 (WebSockets Ready)`);
});