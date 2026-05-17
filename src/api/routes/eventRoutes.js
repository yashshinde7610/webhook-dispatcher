// src/api/routes/eventRoutes.js
const express = require('express');
const router = express.Router();

const events = require('../controllers/eventController');
const { ingestLimiter, operatorLimiter } = require('../middleware');

// POST routes
router.post('/',              ingestLimiter,    events.ingestEvent);
router.post('/:id/replay',   operatorLimiter,  events.replayEvent);

// Read + modify
router.get('/',       events.getEvents);
router.get('/:id',    events.getEventById);
router.patch('/:id',  events.patchEvent);
router.delete('/:id', operatorLimiter, events.deleteEvent);

module.exports = router;
