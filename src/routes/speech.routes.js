const express = require('express');
const { ok } = require('../lib/response');
const { requireAuth } = require('../middleware/auth');
const { transcribeSpeech } = require('../services/speech-service');

const router = express.Router();
const speechJson = express.json({ limit: '8mb' });

router.post('/speech/transcribe', requireAuth(), speechJson, async (req, res, next) => {
  try {
    res.json(ok(await transcribeSpeech({
      ...req.body,
      userId: req.auth.user.id,
      accountUsername: req.auth.user.username
    })));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
