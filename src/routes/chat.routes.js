const express = require('express');
const { handleChatMessage, handleChatMessageStream } = require('../services/baize-chat-service');
const { ok } = require('../lib/response');

const router = express.Router();

function writeSseEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.post('/chat', async (req, res, next) => {
  try {
    res.json(ok(await handleChatMessage(req.body)));
  } catch (error) {
    next(error);
  }
});

router.post('/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  try {
    await handleChatMessageStream(req.body, {
      onEvent: (event) => writeSseEvent(res, event)
    });
  } catch (error) {
    writeSseEvent(res, {
      type: 'error',
      code: error.code || 'INTERNAL_ERROR',
      message: error.publicMessage || 'Internal server error.'
    });
  } finally {
    res.end();
  }
});

module.exports = router;
