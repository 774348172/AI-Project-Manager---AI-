const express = require('express');
const {
  getOperation,
  confirmOperation,
  rejectOperation,
  recordApplicationResult,
  updateOperation
} = require('../services/pending-operation-service');
const { getClaudeCodeConfig } = require('../services/config-service');
const { runClaudeCodeTask } = require('../services/claude-code-service');
const { ok } = require('../lib/response');

const router = express.Router();

async function confirmAndGenerateProposal(operationId, input = {}, { runner } = {}) {
  const confirmedOperation = await confirmOperation(operationId, input);
  await updateOperation(confirmedOperation.id, { status: 'running' });

  try {
    const claudeCodeConfig = await getClaudeCodeConfig();
    const proposal = await runClaudeCodeTask({
      message: { text: confirmedOperation.requestedBy.text },
      permissionMode: confirmedOperation.permission.mode,
      claudeCodeConfig,
      runner
    });

    return updateOperation(confirmedOperation.id, {
      status: 'awaiting_local_apply',
      proposal
    });
  } catch (error) {
    await updateOperation(confirmedOperation.id, {
      status: 'failed',
      application: {
        status: 'not_applied',
        error: error.publicMessage || error.message || '生成补丁草案失败。'
      }
    });
    throw error;
  }
}

router.get('/claude-code/operations/:operationId', async (req, res, next) => {
  try {
    res.json(ok({ operation: await getOperation(req.params.operationId) }));
  } catch (error) {
    next(error);
  }
});

router.post('/claude-code/operations/:operationId/confirm', async (req, res, next) => {
  try {
    res.json(ok({
      operation: await confirmAndGenerateProposal(req.params.operationId, req.body, {
        runner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/claude-code/operations/:operationId/reject', async (req, res, next) => {
  try {
    res.json(ok({ operation: await rejectOperation(req.params.operationId, req.body) }));
  } catch (error) {
    next(error);
  }
});

router.post('/claude-code/operations/:operationId/application-result', async (req, res, next) => {
  try {
    res.json(ok({ operation: await recordApplicationResult(req.params.operationId, req.body) }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.confirmAndGenerateProposal = confirmAndGenerateProposal;
