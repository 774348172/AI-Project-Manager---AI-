const { createApp } = require('./app');
const { recoverInterruptedBugAnalysisRuns } = require('./services/jira-bug-analysis-service');

const BUG_ANALYSIS_TICK_MS = 60 * 1000;

function startServer({ host = process.env.HOST || '0.0.0.0', port = Number(process.env.PORT || 3000), bugAnalysisTickMs = BUG_ANALYSIS_TICK_MS } = {}) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`baize-local-hub listening at http://${host}:${actualPort}`);
  });

  const recoverBugAnalysisRuns = () => {
    recoverInterruptedBugAnalysisRuns({
      fetchImpl: app.locals.jiraFetch,
      claudeCodeRunner: app.locals.claudeCodeRunner
    }).catch((error) => {
      console.error('[jira-bug-analysis] failed to recover interrupted runs:', error && error.message ? error.message : error);
    });
  };

  setImmediate(recoverBugAnalysisRuns);
  const bugAnalysisTimer = bugAnalysisTickMs > 0 ? setInterval(recoverBugAnalysisRuns, bugAnalysisTickMs) : null;
  if (bugAnalysisTimer && typeof bugAnalysisTimer.unref === 'function') {
    bugAnalysisTimer.unref();
  }
  server.on('close', () => {
    if (bugAnalysisTimer) {
      clearInterval(bugAnalysisTimer);
    }
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer
};
