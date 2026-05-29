const express = require('express');
const { ok } = require('../lib/response');
const { getClientRuntimeStatus, getPluginUpdates } = require('../services/control-plane-service');

const router = express.Router();

router.get('/client/runtime', async (req, res, next) => {
  try {
    res.json(ok(await getClientRuntimeStatus({
      clientId: req.query.clientId,
      platform: req.query.platform || 'windows'
    })));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/updates', async (req, res, next) => {
  try {
    res.json(ok(await getPluginUpdates()));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
