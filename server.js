// server.js
require('dotenv').config();
const express = require('express');
const { addToQueue } = require('./src/queue');

const app = express();
app.use(express.json());

// --- SECURITY MIDDLEWARE (The Bouncer) ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    // Check if the key provided matches the one in our .env file
    if (apiKey !== process.env.API_KEY) {
        console.log(`⛔ Blocked unauthorized request.`);
        return res.status(403).json({ error: '⛔ Access Denied: Invalid API Key' });
    }
    next(); // Key is good, proceed to the route
};

// --- ROUTE ---
// Notice we added 'validateApiKey' as the second argument here
app.post('/api/events', validateApiKey, async (req, res) => {
    try {
        const jobData = req.body;
        await addToQueue(jobData);
        res.status(202).json({ 
            status: 'accepted', 
            message: 'Job pushed to queue' 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} 🛡️ (Security Active)`);
});