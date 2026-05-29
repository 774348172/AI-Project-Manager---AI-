const express = require('express');
const { handleWeComWebhook } = require('../services/wecom-service');
const {
  getKnowledgeBaseStatus,
  searchKnowledgeBase,
  registerKnowledgeBaseResult
} = require('../services/knowledge-base-service');
const { getJiraStatus } = require('../services/jira-client-service');
const { searchAndAnalyzeJira } = require('../services/jira-search-service');
const { createJiraImportDrafts } = require('../services/jira-import-service');
const {
  createJiraCreateOperation,
  getJiraOperation,
  applyJiraOperationRecovery,
  updateJiraOperationDrafts,
  rejectJiraOperation
} = require('../services/jira-operation-service');
const { confirmJiraOperationThroughClaudeCode, confirmPluginAudit, rejectPluginAudit } = require('../services/baize-chat-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.post('/plugins/wecom/webhook', async (req, res, next) => {
  try {
    res.json(ok(await handleWeComWebhook(req.body)));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/jira/status', async (req, res, next) => {
  try {
    res.json(ok(await getJiraStatus()));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/search', async (req, res, next) => {
  try {
    res.json(ok(await searchAndAnalyzeJira(req.body, {
      fetchImpl: req.app.locals.jiraFetch,
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/import-drafts', async (req, res, next) => {
  try {
    const draftImport = await createJiraImportDrafts(req.body);
    const operation = await createJiraCreateOperation({
      ...draftImport,
      clientId: req.body.clientId,
      userId: req.body.userId,
      conversationId: req.body.conversationId
    });
    res.json(ok({ ...draftImport, operation }));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/jira/operations/:operationId', async (req, res, next) => {
  try {
    res.json(ok({ operation: await getJiraOperation(req.params.operationId) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/operations/:operationId/confirm', async (req, res, next) => {
  try {
    res.json(ok({
      operation: await confirmJiraOperationThroughClaudeCode(req.params.operationId, req.body, {
        fetchImpl: req.app.locals.jiraFetch,
        claudeCodeRunner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/operations/:operationId/drafts', async (req, res, next) => {
  try {
    res.json(ok({
      operation: await updateJiraOperationDrafts(req.params.operationId, req.body || {}, {
        fetchImpl: req.app.locals.jiraFetch
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/operations/:operationId/reject', async (req, res, next) => {
  try {
    res.json(ok({ operation: await rejectJiraOperation(req.params.operationId, req.body) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/operations/:operationId/recovery', async (req, res, next) => {
  try {
    res.json(ok({
      operation: await applyJiraOperationRecovery(req.params.operationId, req.body, {
        fetchImpl: req.app.locals.jiraFetch
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/audit/:auditId/confirm', async (req, res, next) => {
  try {
    res.json(ok(await confirmPluginAudit(req.params.auditId, req.body || {}, {
      fetchImpl: req.app.locals.jiraFetch,
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/audit/:auditId/reject', async (req, res, next) => {
  try {
    res.json(ok(await rejectPluginAudit(req.params.auditId, req.body || {})));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/knowledge-base/status', async (req, res, next) => {
  try {
    res.json(ok(await getKnowledgeBaseStatus()));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/knowledge-base/search', async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    res.json(ok({ results: await searchKnowledgeBase({ q, limit }) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/knowledge-base/deep-index', async (req, res, next) => {
  try {
    const { category, title, path, tags, summary } = req.body;
    res.json(ok(await registerKnowledgeBaseResult({ category, title, path, tags, summary })));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
