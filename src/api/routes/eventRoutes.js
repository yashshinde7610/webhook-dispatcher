// src/api/routes/eventRoutes.js
const express = require('express');
const router = express.Router();

const events = require('../controllers/eventController');
const { ingestLimiter, operatorLimiter, readLimiter } = require('../middleware');

// Ingest
router.post('/',              ingestLimiter,    events.ingestEvent);

// Operator actions (stricter budget — each enqueues BullMQ work)
router.post('/:id/replay',   operatorLimiter,  events.replayEvent);
router.delete('/:id',        operatorLimiter,  events.deleteEvent);

// Reads (pagination + countDocuments hit Mongo)
router.get('/',       readLimiter, events.getEvents);
router.get('/:id',    readLimiter, events.getEventById);

// Patch (shares operator budget — prevents MongoDB connection pool exhaustion)
router.patch('/:id',  operatorLimiter, events.patchEvent);

module.exports = router;
