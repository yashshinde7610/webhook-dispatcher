const express = require('express');
const { addToQueue } = require('./src/queue'); // Import the queue logic
const app = express();

app.use(express.json());

app.post('/api/events', async (req, res) => {
    // 1. Send data to Redis (The Queue)
    await addToQueue(req.body);

    // 2. Respond immediately (Don't wait for processing)
    res.status(202).json({ 
        status: 'accepted', 
        message: 'Job pushed to queue' 
    });
});

app.listen(3000, () => {
    console.log('Webhook Dispatcher running on port 3000');
});