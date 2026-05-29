const jiraRules = require('./audit-rules/jira');

const PLUGIN_RULES = {
  jira: jiraRules
};

async function auditPluginOperation({ plugin, kind, issueKeys = [], triggerSource = 'client', baizeRoot } = {}) {
  const pluginId = typeof plugin === 'string' ? plugin.trim() : '';
  if (!pluginId) {
    return {
      decision: 'deny',
      summary: '白泽：网关需要明确的 plugin 名称。',
      perIssue: [],
      plugin: pluginId || null,
      kind: kind || null,
      triggerSource
    };
  }
  const rules = PLUGIN_RULES[pluginId];
  if (!rules) {
    return {
      decision: 'deny',
      summary: `白泽：插件 ${pluginId} 还没有登记审计规则，默认拒绝。`,
      perIssue: [],
      plugin: pluginId,
      kind: kind || null,
      triggerSource
    };
  }
  const audit = await rules.audit({ kind, issueKeys, triggerSource, baizeRoot });
  return {
    ...audit,
    plugin: pluginId,
    kind: kind || null,
    triggerSource
  };
}

function listSupportedPlugins() {
  return Object.keys(PLUGIN_RULES);
}

module.exports = {
  auditPluginOperation,
  listSupportedPlugins
};
