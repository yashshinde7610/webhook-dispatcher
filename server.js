// server.js
const connectDB = require('./src/db');
connectDB(); 
const redis = require('./src/redis'); 
const crypto = require('crypto'); 
const chalk = require('chalk');   
const figlet = require('figlet'); 

require('dotenv').config();
const Event = require('./src/models/Event'); 
const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
const { addToQueue, myQueue } = require('./src/queue');
const { QueueEvents } = require('bullmq'); 
const { applyFieldMask } = require('./src/utils/fieldMask'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server); 

app.use(express.json());
app.use(express.static('public')); 

// --- 🎧 QUEUE LISTENER ---
const queueEvents = new QueueEvents('webhook-queue', {
    connection: { 
        host: process.env.REDIS_HOST || '127.0.0.1', 
        port: Number(process.env.REDIS_PORT) || 6379 
    }
});

queueEvents.on('completed', ({ jobId, returnvalue }) => {
    let result = {};
    if (typeof returnvalue === 'object') {
        result = returnvalue; 
    } else if (typeof returnvalue === 'string') {
        try {
            result = JSON.parse(returnvalue);
        } catch (e) {
            result = { status: 'Completed', response: returnvalue };
        }
    }

    let realId = jobId;
    if (result && result.dbId) realId = result.dbId;

    console.log(`⚡ Event: Job ${realId} completed!`);
    
    io.emit('job-update', { 
        id: realId, 
        status: result.status || 'Completed', 
        timestamp: new Date(),
        response: result.response || result 
    });
});

queueEvents.on('failed', async ({ jobId, failedReason }) => {
    let realId = jobId;
    try {
        const job = await myQueue.getJob(jobId);
        if (job && job.data.dbId) realId = job.data.dbId; 
    } catch (e) { console.error("⚠️ Could not fetch failed job details"); }

    console.log(`⚡ Event: Job ${realId} failed!`);
    io.emit('job-update', { id: realId, status: 'Failed', reason: failedReason });
});

// --- 🛡️ MIDDLEWARE ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({ error: '⛔ Access Denied: Invalid API Key' });
    }
    next();
};

// --- 📊 SYSTEM HEALTH HEARTBEAT ---
setInterval(async () => {
    try {
        const counts = await myQueue.getJobCounts('waiting', 'active', 'completed', 'failed');
        io.emit('dashboard-stats', {
            waiting: counts.waiting,
            active: counts.active,
            failed: counts.failed,
            completed: counts.completed,
            redisStatus: redis.status 
        });
    } catch (err) {
        // console.error('Metrics Error:', err.message); 
    }
}, 2000);

// --- 📥 POST ROUTE (Ingestion) ---
app.post('/api/events', validateApiKey, async (req, res) => {
    const traceId = crypto.randomUUID(); 

    if (redis.status !== 'ready') {
        console.error(`[Trace: ${traceId}] 🛑 Critical: Redis is ${redis.status}`);
        return res.status(503).json({ 
            error: 'Service Unavailable', 
            message: 'Ingestion paused due to infrastructure outage.',
            code: 'INGESTION_PAUSED_REDIS_UNAVAILABLE', 
            traceId
        });
    }

    console.log(`[Trace: ${traceId}] 🔍 Ingress: New Request`); 
    
    const idempotencyKey = req.headers['idempotency-key'];
    const forceRetry = req.headers['x-force-retry'] === 'true';
    const jobData = req.body;

    try {
        if (idempotencyKey && !forceRetry) {
            const key = `idempotency:${idempotencyKey}`;
            const exists = await redis.get(key);
            if (exists) {
                console.warn(`[Trace: ${traceId}] 🛑 Idempotency Block`);
                return res.status(409).json({ 
                    error: 'Conflict', 
                    message: 'Event already processed', 
                    traceId 
                });
            }
        }

        const eventLog = new Event({
            traceId: traceId,
            source: 'API_KEY_USER', 
            payload: jobData,
            url: jobData.url,
            status: 'PENDING',
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED'
        });
        await eventLog.save(); 
        
        console.log(`[Trace: ${traceId}] 💾 Job saved. ID: ${eventLog._id}`);

        await addToQueue({ 
            ...jobData, 
            dbId: eventLog._id,
            traceId,
            deliverySemantics: 'AT_LEAST_ONCE_UNORDERED'
        });

        if (idempotencyKey) {
            await redis.set(`idempotency:${idempotencyKey}`, JSON.stringify({ id: eventLog._id }), 'EX', 86400);
        }
        
        io.emit('job-update', { id: eventLog._id, status: 'Pending', data: jobData, traceId });
        
        res.status(202).json({ 
            status: 'accepted', 
            message: 'Job pushed to queue', 
            id: eventLog._id,
            traceId 
        });

    } catch (error) {
        console.error(`[Trace: ${traceId}] 💥 Error: ${error.message}`);
        res.status(500).json({ error: error.message, traceId });
    }
});

// --- 🔄 REPLAY ROUTE (Restored!) ---
app.post('/api/events/:id/replay', validateApiKey, async (req, res) => {
    try {
        const eventLog = await Event.findById(req.params.id);
        
        if (!eventLog) {
            return res.status(404).json({ error: 'Event not found' });
        }

        eventLog.status = 'PENDING';
        eventLog.logs.push({ 
            attempt: eventLog.logs.length + 1, 
            status: 0, 
            response: 'Manual Replay Triggered' 
        });
        await eventLog.save();

        const jobId = eventLog._id.toString();
        const existingJob = await myQueue.getJob(jobId);
        if (existingJob) {
            await existingJob.remove(); 
        }

        await addToQueue({ 
            ...eventLog.payload, 
            dbId: eventLog._id 
        });

        io.emit('job-update', { id: eventLog._id, status: 'Pending (Replay)', data: eventLog.payload });

        res.json({ message: 'Replay started', id: eventLog._id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 🛠️ PATCH ROUTE (With Field Mask) ---
app.patch('/api/events/:id', validateApiKey, async (req, res) => {
    const { id } = req.params;
    // Look in URL first, fallback to Header if URL fails
const updateMask = req.query.updateMask || req.headers['x-update-mask'];
    const updateData = req.body;

    console.log('🔍 DEBUG PATCH:', { id, mask: updateMask, bodyKeys: Object.keys(updateData) });

    try {
        const safeUpdates = applyFieldMask(updateData, updateMask);

        if (Object.keys(safeUpdates).length === 0) {
            return res.status(400).json({ 
                error: 'No valid fields to update. Did you provide an updateMask?',
                receivedMask: updateMask,
                receivedBody: updateData
            });
        }

        console.log(`[Patch] Updating Event ${id} with mask [${updateMask}]`);

        const result = await Event.updateOne({ _id: id }, { $set: safeUpdates });

        if (result.matchedCount === 0) return res.status(404).json({ error: 'Event not found' });

        io.emit('job-update', { 
            id: id, 
            status: safeUpdates.status || 'Updated', 
            response: `Patched fields: ${Object.keys(safeUpdates).join(', ')}` 
        });

        res.json({ message: 'Event updated successfully', updatedFields: Object.keys(safeUpdates) });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => { 
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