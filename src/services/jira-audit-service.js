const { auditPluginOperation } = require('./plugin-gateway-service');
const { COMMENT_KINDS, ISSUE_WRITE_KINDS, READ_KINDS } = require('./audit-rules/jira');

async function auditJiraOperation(input = {}) {
  const result = await auditPluginOperation({ ...input, plugin: 'jira' });
  return { ...result, kind: input.kind || result.kind, triggerSource: input.triggerSource || result.triggerSource };
}

module.exports = {
  auditJiraOperation,
  COMMENT_KINDS,
  ISSUE_WRITE_KINDS,
  READ_KINDS
};
