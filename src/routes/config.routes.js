const express = require('express');
const { getGlobalConfig, getPublicClaudeConfig, getPublicClaudeCodeConfig, getPublicJiraConfig } = require('../services/config-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.get('/config/global', async (req, res, next) => {
  try {
    res.json(ok(await getGlobalConfig()));
  } catch (error) {
    next(error);
  }
});

router.get('/config/claude', async (req, res, next) => {
  try {
    res.json(ok(await getPublicClaudeConfig()));
  } catch (error) {
    next(error);
  }
});

router.get('/config/claude-code', async (req, res, next) => {
  try {
    res.json(ok(await getPublicClaudeCodeConfig()));
  } catch (error) {
    next(error);
  }
});

router.get('/config/jira', async (req, res, next) => {
  try {
    res.json(ok(await getPublicJiraConfig()));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
