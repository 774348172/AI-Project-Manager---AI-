const express = require('express');
const { ok } = require('../lib/response');
const { uploadAttachment, getAttachment, rememberAttachment } = require('../services/attachment-service');

const router = express.Router();
const uploadJson = express.json({ limit: '70mb' });

router.post('/attachments/upload', uploadJson, async (req, res, next) => {
  try {
    res.json(ok({ attachment: await uploadAttachment(req.body) }));
  } catch (error) {
    next(error);
  }
});

router.get('/attachments/:attachmentId', async (req, res, next) => {
  try {
    res.json(ok({ attachment: await getAttachment(req.params.attachmentId) }));
  } catch (error) {
    next(error);
  }
});

router.post('/attachments/:attachmentId/remember', express.json({ limit: '256kb' }), async (req, res, next) => {
  try {
    res.json(ok({ attachment: await rememberAttachment(req.params.attachmentId, req.body) }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
