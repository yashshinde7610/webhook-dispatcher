// server.js
const connectDB = require('./src/db');
connectDB(); // <--- Connects to Mongo immediately
const redis = require('./src/redis'); // <--- 1. IMPORT REDIS
const crypto = require('crypto'); // Built-in Node.js module

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
    connection: { 
        host: process.env.REDIS_HOST || '127.0.0.1', 
        port: Number(process.env.REDIS_PORT) || 6379 
    }
});

// REPLACE your 'completed' listener with this DEBUG version:
// server.js - Find the 'queueEvents.on' block and replace it with this:

queueEvents.on('completed', ({ jobId, returnvalue }) => {
    let result = {};
    
    // 1. SAFE PARSING LOGIC
    if (typeof returnvalue === 'object') {
        result = returnvalue; // It's already an object (Redis did it for us)
    } else if (typeof returnvalue === 'string') {
        try {
            // Try to parse it as JSON
            result = JSON.parse(returnvalue);
        } catch (e) {
            // 💡 THE FIX: If parsing fails, it's just plain text. Don't panic.
            result = { 
                status: 'Completed', 
                response: returnvalue // Save the plain text message here
            };
        }
    }

    // 2. EXTRACT ID (Handle both normal jobs and custom DB jobs)
    let realId = jobId;
    if (result && result.dbId) {
        realId = result.dbId;
    }

    // 3. LOGGING & NOTIFICATION
    console.log(`⚡ Event: Job ${realId} completed! Response: ${JSON.stringify(result.response || result)}`);
    
    io.emit('job-update', { 
        id: realId, 
        status: result.status || 'Completed', 
        timestamp: new Date(),
        response: result.response || result 
    });
});

// REPLACE your old 'failed' listener with this SMARTER version:

queueEvents.on('failed', async ({ jobId, failedReason }) => {
    // 1. Try to find the job details to get the REAL DB ID
    let realId = jobId;
    
    try {
        const job = await myQueue.getJob(jobId);
        if (job && job.data.dbId) {
            realId = job.data.dbId; // Found the parent ID!
        }
    } catch (e) {
        console.error("⚠️ Could not fetch failed job details");
    }

    console.log(`⚡ Event: Job ${realId} failed!`);
    
    // 2. Update the ORIGINAL card to Failed (Red)
    io.emit('job-update', { id: realId, status: 'Failed', reason: failedReason });
});

// --- SECURITY MIDDLEWARE ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({ error: '⛔ Access Denied: Invalid API Key' });
    }
    next();
};
// --- API ROUTE (With Idempotency & Override Flag) ---
app.post('/api/events', validateApiKey, async (req, res) => {
    // 1. GENERATE TRACE ID (The "Digital Thread")
    const traceId = crypto.randomUUID(); // <--- 2. GENERATE ID

    // 2. EXTRACT HEADERS & LOGGING
    // We now include the traceId in the log so we can find this exact request later
    console.log(`[Trace: ${traceId}] 🔍 Ingress: New Request Received`); 
    
    const idempotencyKey = req.headers['idempotency-key'];
    const forceRetry = req.headers['x-force-retry'] === 'true';
    const jobData = req.body;

    try {
        // --- 🛡️ IDEMPOTENCY CHECK ---
        if (idempotencyKey && !forceRetry) {
            const key = `idempotency:${idempotencyKey}`;
            const exists = await redis.get(key);

            if (exists) {
                console.warn(`[Trace: ${traceId}] 🛑 Idempotency: Duplicate Key ${idempotencyKey} blocked.`);
                return res.status(409).json({ 
                    error: 'Conflict', 
                    message: 'This event has already been processed.', 
                    originalJobId: JSON.parse(exists).id,
                    traceId // <--- Return ID so client can debug
                });
            }
        }

        // --- NORMAL PROCESSING ---
        
        // 3. DATABASE
        const eventLog = new Event({
            source: 'API_KEY_USER', 
            payload: jobData,
            targetUrl: jobData.url,
            status: 'PENDING',
            // traceId: traceId // (Optional: Add this to schema if you want DB searching)
        });
        await eventLog.save(); 
        
        console.log(`[Trace: ${traceId}] 💾 Job saved to DB. ID: ${eventLog._id}`);

        // 4. QUEUE (Pass the Trace ID!)
        await addToQueue({ 
            ...jobData, 
            dbId: eventLog._id,
            traceId // <--- 3. PASS THE TORCH (Send ID to Worker)
        });

        // --- 💾 SAVE IDEMPOTENCY KEY ---
        if (idempotencyKey) {
            await redis.set(
                `idempotency:${idempotencyKey}`, 
                JSON.stringify({ id: eventLog._id }), 
                'EX', 
                86400
            );
        }
        
        // 5. REAL-TIME NOTIFICATION
        io.emit('job-update', { 
            id: eventLog._id, 
            status: 'Pending', 
            data: jobData,
            traceId // <--- Send to Dashboard too
        });
        
        // 6. RESPONSE
        res.status(202).json({ 
            status: 'accepted', 
            message: forceRetry ? 'Job forced into queue' : 'Job pushed to queue', 
            id: eventLog._id,
            traceId // <--- 4. GIVE RECEIPT (Return ID to User)
        });

    } catch (error) {
        console.error(`[Trace: ${traceId}] 💥 Error: ${error.message}`);
        res.status(500).json({ error: error.message, traceId });
    }
});
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
// --- 🎨 VISUAL DASHBOARD ---
const figlet = require('figlet');
const chalk = require('chalk');

// 1. Define PORT only ONCE
const PORT = process.env.PORT || 3000;

// 2. Start the Server
server.listen(PORT, () => { // <--- ✅ USE 'server', NOT 'app'
    console.clear(); 
    
    // Big Text Banner
    console.log(
        chalk.green(
            figlet.textSync('Webhook API', { horizontalLayout: 'full' })
        )
    );

    // Status Panel
    console.log(chalk.blue.bold('\n🔹 SYSTEM STATUS DASHBOARD 🔹'));
    console.log(chalk.gray('-----------------------------------'));
    console.log(`✅  Server Status:    ${chalk.green('ONLINE')}`);
    console.log(`🔗  Port:             ${chalk.yellow(PORT)}`);
    console.log(`🔑  Security:         ${chalk.cyan('HMAC + API Key Active')}`);
    console.log(`🧠  Idempotency:      ${chalk.magenta('Redis-Backed')}`);
    console.log(chalk.gray('-----------------------------------'));
    console.log(chalk.white('Waiting for incoming events...'));
});