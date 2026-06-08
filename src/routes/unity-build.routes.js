const express = require('express');
const { ok } = require('../lib/response');
const {
  readSchedulerState,
  setUnityBuildSchedulerEnabled,
  tickUnityBuildScheduler,
  executeUnityBuildOnce
} = require('../services/unity-build-service');

const router = express.Router();

router.get('/plugins/unity-build/status', async (req, res, next) => {
  try {
    res.json(ok({ state: await readSchedulerState() }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/unity-build/scheduler', async (req, res, next) => {
  try {
    const enabled = req.body && req.body.enabled === true;
    res.json(ok({ state: await setUnityBuildSchedulerEnabled(enabled, req.body || {}) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/unity-build/run-once', async (req, res, next) => {
  try {
    res.json(ok({ state: await executeUnityBuildOnce({ fetchImpl: req.app.locals.wecomFetch }) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/unity-build/scheduler/tick', async (req, res, next) => {
  try {
    res.json(ok(await tickUnityBuildScheduler({ fetchImpl: req.app.locals.wecomFetch })));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
