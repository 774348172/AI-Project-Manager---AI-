const express = require('express');
const {
  createRequirementCompletionRun,
  getRequirementCompletionRun,
  generateRequirementCompletionPlan,
  confirmAndEnqueueRequirementCompletionRun,
  enqueueRequirementCompletionRun,
  applyRequirementCompletionRecovery
} = require('../services/requirement-completion-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.post('/plugins/engineering/requirement-completion/runs', async (req, res, next) => {
  try {
    res.json(ok(await createRequirementCompletionRun(req.body || {})));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/engineering/requirement-completion/runs/:runId', async (req, res, next) => {
  try {
    res.json(ok({ run: await getRequirementCompletionRun(req.params.runId) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/engineering/requirement-completion/runs/:runId/plan', async (req, res, next) => {
  try {
    res.json(ok({
      run: await generateRequirementCompletionPlan(req.params.runId, req.body || {}, {
        claudeCodeRunner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/engineering/requirement-completion/runs/:runId/confirm', async (req, res, next) => {
  try {
    res.json(ok(await confirmAndEnqueueRequirementCompletionRun(req.params.runId, req.body || {}, {
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/engineering/requirement-completion/runs/:runId/resume', async (req, res, next) => {
  try {
    const enqueue = await enqueueRequirementCompletionRun(req.params.runId, {
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    });
    res.json(ok({ run: enqueue.run, enqueued: enqueue.enqueued, alreadyRunning: enqueue.alreadyRunning }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/engineering/requirement-completion/runs/:runId/recovery', async (req, res, next) => {
  try {
    res.json(ok({
      run: await applyRequirementCompletionRecovery(req.params.runId, req.body || {}, {
        claudeCodeRunner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
