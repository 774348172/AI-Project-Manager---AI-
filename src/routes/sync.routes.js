const express = require('express');
const { appendSyncEvent, listSyncEvents } = require('../services/sync-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.post('/sync/events', async (req, res, next) => {
  try {
    res.json(ok({ event: await appendSyncEvent(req.body || {}) }));
  } catch (error) {
    next(error);
  }
});

router.get('/sync/events', async (req, res, next) => {
  try {
    const { since, limit } = req.query;
    res.json(ok(await listSyncEvents({ since, limit })));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
