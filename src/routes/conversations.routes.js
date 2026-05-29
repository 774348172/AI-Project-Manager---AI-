const express = require('express');
const {
  createConversation,
  getConversation,
  getConversationMessages,
  listConversations,
  updateConversationMetadata
} = require('../services/conversation-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.get('/conversations', async (req, res, next) => {
  try {
    res.json(ok({
      conversations: await listConversations(req.query)
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/conversations', async (req, res, next) => {
  try {
    res.json(ok({
      conversation: await createConversation(req.body)
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/conversations/:conversationId', async (req, res, next) => {
  try {
    res.json(ok(await getConversation(req.params.conversationId)));
  } catch (error) {
    next(error);
  }
});

router.get('/conversations/:conversationId/messages', async (req, res, next) => {
  try {
    res.json(ok({
      messages: await getConversationMessages(req.params.conversationId)
    }));
  } catch (error) {
    next(error);
  }
});

router.patch('/conversations/:conversationId', async (req, res, next) => {
  try {
    res.json(ok({
      conversation: await updateConversationMetadata(req.params.conversationId, req.body)
    }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
