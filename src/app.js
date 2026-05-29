const express = require('express');
const healthRoutes = require('./routes/health.routes');
const configRoutes = require('./routes/config.routes');
const memoryRoutes = require('./routes/memory.routes');
const logicRoutes = require('./routes/logic.routes');
const chatRoutes = require('./routes/chat.routes');
const conversationsRoutes = require('./routes/conversations.routes');
const claudeCodeRoutes = require('./routes/claude-code.routes');
const attachmentsRoutes = require('./routes/attachments.routes');
const clientVersionRoutes = require('./routes/client-version.routes');
const controlPlaneRoutes = require('./routes/control-plane.routes');
const syncRoutes = require('./routes/sync.routes');
const pluginRoutes = require('./routes/plugins.routes');
const jiraBugAnalysisRoutes = require('./routes/jira-bug-analysis.routes');
const { fail } = require('./lib/response');

function createApp() {
  const app = express();

  app.use(attachmentsRoutes);
  app.use(express.json({ limit: '256kb' }));
  app.use(healthRoutes);
  app.use(configRoutes);
  app.use(memoryRoutes);
  app.use(logicRoutes);
  app.use(chatRoutes);
  app.use(conversationsRoutes);
  app.use(claudeCodeRoutes);
  app.use(clientVersionRoutes);
  app.use(controlPlaneRoutes);
  app.use(syncRoutes);
  app.use(pluginRoutes);
  app.use(jiraBugAnalysisRoutes);

  app.use((req, res) => {
    res.status(404).json(fail('NOT_FOUND', 'Route not found.'));
  });

  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      res.status(400).json(fail('VALIDATION_ERROR', 'Invalid JSON body.'));
      return;
    }

    if (error.type === 'entity.too.large') {
      res.status(413).json(fail('PAYLOAD_TOO_LARGE', 'Request body too large.'));
      return;
    }

    const status = error.statusCode || 500;
    const code = status >= 500 ? 'INTERNAL_ERROR' : error.code || 'INTERNAL_ERROR';
    const message = status >= 500 ? 'Internal server error.' : error.publicMessage || 'Internal server error.';
    res.status(status).json(fail(code, message));
  });

  return app;
}

module.exports = {
  createApp
};
