const express = require('express');
const { submitLogicAssertion } = require('../services/logic-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.post('/logic/assertions/draft', async (req, res, next) => {
  try {
    const { category, statement, source } = req.body;
    res.json(ok(await submitLogicAssertion({ category, statement, source })));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
