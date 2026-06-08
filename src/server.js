const { createApp } = require('./app');
const { recoverInterruptedBugAnalysisRuns } = require('./services/jira-bug-analysis-service');
const { recoverInterruptedRequirementCompletionRuns } = require('./services/requirement-completion-service');
const { getUnityBuildConfig, getWeComConfig } = require('./services/config-service');
const { createUnityBuildScheduler } = require('./services/unity-build-service');
const { startWeComAiBot, stopWeComAiBot } = require('./services/wecom-aibot-service');

const BUG_ANALYSIS_TICK_MS = 60 * 1000;
const UNITY_BUILD_TICK_MS = 60 * 1000;

function startServer({ host = process.env.HOST || '0.0.0.0', port = Number(process.env.PORT || 3000), bugAnalysisTickMs = BUG_ANALYSIS_TICK_MS, unityBuildTickMs = UNITY_BUILD_TICK_MS } = {}) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`baize-local-hub listening at http://${host}:${actualPort}`);
  });

  const recoverBackgroundRuns = () => {
    recoverInterruptedBugAnalysisRuns({
      fetchImpl: app.locals.jiraFetch,
      claudeCodeRunner: app.locals.claudeCodeRunner
    }).catch((error) => {
      console.error('[jira-bug-analysis] failed to recover interrupted runs:', error && error.message ? error.message : error);
    });
    recoverInterruptedRequirementCompletionRuns({
      claudeCodeRunner: app.locals.claudeCodeRunner
    }).catch((error) => {
      console.error('[requirement-completion] failed to recover interrupted runs:', error && error.message ? error.message : error);
    });
  };

  setImmediate(recoverBackgroundRuns);
  const bugAnalysisTimer = bugAnalysisTickMs > 0 ? setInterval(recoverBackgroundRuns, bugAnalysisTickMs) : null;
  if (bugAnalysisTimer && typeof bugAnalysisTimer.unref === 'function') {
    bugAnalysisTimer.unref();
  }

  getWeComConfig().then((config) => {
    if (config.aiBot.enabled) {
      return startWeComAiBot({ config });
    }
    return null;
  }).catch((error) => {
    console.error('[wecom-aibot] failed to start:', error && error.message ? error.message : error);
  });

  const unityBuildScheduler = unityBuildTickMs > 0 ? createUnityBuildScheduler({
    tickMs: unityBuildTickMs,
    fetchImpl: app.locals.wecomFetch
  }) : null;
  if (unityBuildScheduler) {
    unityBuildScheduler.start();
    getUnityBuildConfig().then((config) => {
      if (config.runOnServerStart) {
        return unityBuildScheduler.tick();
      }
      return null;
    }).catch((error) => {
      console.error('[unity-build] failed to run scheduler on server start:', error && error.message ? error.message : error);
    });
  }

  server.on('close', () => {
    if (bugAnalysisTimer) {
      clearInterval(bugAnalysisTimer);
    }
    if (unityBuildScheduler) {
      unityBuildScheduler.stop();
    }
    stopWeComAiBot();
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer
};
