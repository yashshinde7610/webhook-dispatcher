// src/api/routes/eventRoutes.js
const express = require('express');
const router = express.Router();

const events = require('../controllers/eventController');
const { ingestLimiter } = require('../middleware');

// POST routes
router.post('/',              ingestLimiter, events.ingestEvent);
router.post('/:id/replay',                  events.replayEvent);
router.post('/:id/suggest-fix',             events.suggestFix);

// Read + modify
router.get('/',       events.getEvents);
router.get('/:id',    events.getEventById);
router.patch('/:id',  events.patchEvent);
router.delete('/:id', events.deleteEvent);

module.exports = router;
