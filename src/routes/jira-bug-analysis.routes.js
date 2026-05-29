const express = require('express');
const {
  createBugAnalysisRun,
  getBugAnalysisRun,
  confirmBugAnalysisRun,
  enqueueBugAnalysisRun,
  resumeBugAnalysisRun,
  processDueBugAnalysisRuns,
  processNextBugAnalysisItem,
  analyzeBugAnalysisItem,
  confirmBugAnalysisItemComment,
  applyBugAnalysisRecovery
} = require('../services/jira-bug-analysis-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.post('/plugins/jira/bug-analysis/runs', async (req, res, next) => {
  try {
    res.json(ok(await createBugAnalysisRun(req.body || {}, {
      fetchImpl: req.app.locals.jiraFetch
    })));
  } catch (error) {
    next(error);
  }
});

router.get('/plugins/jira/bug-analysis/runs/:runId', async (req, res, next) => {
  try {
    res.json(ok({ run: await getBugAnalysisRun(req.params.runId) }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/runs/:runId/confirm', async (req, res, next) => {
  try {
    const run = await confirmBugAnalysisRun(req.params.runId, req.body || {});
    const enqueue = await enqueueBugAnalysisRun(run.id, {
      fetchImpl: req.app.locals.jiraFetch,
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    });
    res.json(ok({ run: enqueue.run, enqueued: enqueue.enqueued, alreadyRunning: enqueue.alreadyRunning }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/runs/:runId/resume', async (req, res, next) => {
  try {
    res.json(ok(await resumeBugAnalysisRun(req.params.runId, req.body || {}, {
      fetchImpl: req.app.locals.jiraFetch,
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/scheduler/tick', async (req, res, next) => {
  try {
    res.json(ok(await processDueBugAnalysisRuns({
      fetchImpl: req.app.locals.jiraFetch,
      claudeCodeRunner: req.app.locals.claudeCodeRunner
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/runs/:runId/process-next', async (req, res, next) => {
  try {
    res.json(ok({
      run: await processNextBugAnalysisItem(req.params.runId, {
        fetchImpl: req.app.locals.jiraFetch,
        claudeCodeRunner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/runs/:runId/items/:itemId/analyze', async (req, res, next) => {
  try {
    res.json(ok({
      run: await analyzeBugAnalysisItem(req.params.runId, req.params.itemId, {
        fetchImpl: req.app.locals.jiraFetch,
        claudeCodeRunner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/runs/:runId/items/:itemId/comment/confirm', async (req, res, next) => {
  try {
    res.json(ok({
      run: await confirmBugAnalysisItemComment(req.params.runId, req.params.itemId, req.body || {}, {
        fetchImpl: req.app.locals.jiraFetch
      })
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/plugins/jira/bug-analysis/runs/:runId/items/:itemId/recovery', async (req, res, next) => {
  try {
    res.json(ok({
      run: await applyBugAnalysisRecovery(req.params.runId, req.params.itemId, req.body || {}, {
        fetchImpl: req.app.locals.jiraFetch,
        claudeCodeRunner: req.app.locals.claudeCodeRunner
      })
    }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
