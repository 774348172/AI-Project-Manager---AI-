const express = require('express');
const { handleChatMessage, handleChatMessageStream } = require('../services/baize-chat-service');
const { ok } = require('../lib/response');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function writeSseEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function withAuthenticatedUser(req) {
  return {
    ...(req.body || {}),
    userId: req.auth.user.id,
    accountUsername: req.auth.user.username
  };
}

router.post('/chat', requireAuth(), async (req, res, next) => {
  try {
    res.json(ok(await handleChatMessage(withAuthenticatedUser(req))));
  } catch (error) {
    next(error);
  }
});

router.post('/chat/stream', requireAuth(), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  writeSseEvent(res, { type: 'activity', step: 'request_received', message: '白泽已收到请求。', at: new Date().toISOString() });
  const heartbeat = setInterval(() => {
    writeSseEvent(res, { type: 'heartbeat', at: new Date().toISOString() });
  }, 10000);

  try {
    await handleChatMessageStream(withAuthenticatedUser(req), {
      onEvent: (event) => writeSseEvent(res, event)
    });
  } catch (error) {
    writeSseEvent(res, {
      type: 'error',
      code: error.code || 'INTERNAL_ERROR',
      message: error.publicMessage || 'Internal server error.'
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
