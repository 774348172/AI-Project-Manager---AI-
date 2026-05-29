const path = require('path');
const YAML = require('yaml');
const paths = require('../config/paths');
const { readTextIfExists } = require('../lib/file-store');
const { getClaudeCodeConfig, getJiraConfig } = require('./config-service');

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function readStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [readString(key), readString(item)])
    .filter(([key, item]) => key && item));
}

function publicPluginPermissions(value = {}) {
  const permissions = readObject(value);
  return {
    allowLocalDecision: readBoolean(permissions.allowLocalDecision) ?? true,
    allowedActions: readArray(permissions.allowedActions).map(readString).filter(Boolean),
    deniedActions: readArray(permissions.deniedActions).map(readString).filter(Boolean),
    requiresUserConfirmation: readBoolean(permissions.requiresUserConfirmation) ?? false
  };
}

async function readYamlConfig(fileName, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const text = await readTextIfExists(path.join(baizeRoot, 'config', fileName));
  return text.trim() === '' ? {} : YAML.parse(text) || {};
}

function publicRuntimePackage(config = {}) {
  const runtimePackage = readObject(config.runtimePackage);
  return {
    enabled: readBoolean(runtimePackage.enabled) ?? false,
    version: readString(runtimePackage.version),
    platform: readString(runtimePackage.platform) || 'windows',
    url: readString(runtimePackage.url),
    sha256: readString(runtimePackage.sha256),
    required: readBoolean(runtimePackage.required) ?? false
  };
}

async function getClientRuntimeStatus(input = {}, options = {}) {
  const [runtimeConfig, claudeCodeConfig, jiraConfig] = await Promise.all([
    readYamlConfig('client-runtime.yaml', options),
    getClaudeCodeConfig(options),
    getJiraConfig(options)
  ]);
  const localClaudeCode = readObject(runtimeConfig.localClaudeCode);
  return {
    enabled: readBoolean(runtimeConfig.enabled) ?? true,
    clientId: readString(input.clientId) || '',
    platform: readString(input.platform) || 'windows',
    localClaudeCode: {
      enabled: readBoolean(localClaudeCode.enabled) ?? claudeCodeConfig.enabled === true,
      managedByServer: readBoolean(localClaudeCode.managedByServer) ?? true,
      minVersion: readString(localClaudeCode.minVersion),
      command: readString(localClaudeCode.command) || readString(claudeCodeConfig.command) || 'claude',
      env: readStringMap(claudeCodeConfig.env)
    },
    runtimePackage: publicRuntimePackage(runtimeConfig),
    jira: {
      enabled: true,
      baseURL: readString(jiraConfig.baseURL),
      deploymentType: readString(jiraConfig.deploymentType) || 'server',
      apiVersion: readString(jiraConfig.apiVersion) || '2',
      authType: readString(jiraConfig.authType) || 'basic',
      email: readString(jiraConfig.email),
      username: readString(jiraConfig.username),
      password: readString(jiraConfig.password),
      apiToken: readString(jiraConfig.apiToken),
      defaultProjectKey: readString(jiraConfig.defaultProjectKey),
      defaultIssueType: readString(jiraConfig.defaultIssueType) || 'Task',
      fieldMappings: readStringMap(jiraConfig.fieldMappings)
    },
    sync: {
      enabled: readBoolean(readObject(runtimeConfig.sync).enabled) ?? true,
      pollIntervalMs: Number(readObject(runtimeConfig.sync).pollIntervalMs) || 30000
    }
  };
}

async function getPluginUpdates(options = {}) {
  const config = await readYamlConfig('plugin-updates.yaml', options);
  const plugins = readArray(config.plugins).map((plugin) => {
    const item = readObject(plugin);
    return {
      id: readString(item.id),
      name: readString(item.name),
      enabled: readBoolean(item.enabled) ?? true,
      version: readString(item.version),
      updateUrl: readString(item.updateUrl),
      sha256: readString(item.sha256),
      required: readBoolean(item.required) ?? false,
      permissions: publicPluginPermissions(item.permissions),
      updatedAt: readString(item.updatedAt)
    };
  }).filter((plugin) => plugin.id);

  return {
    enabled: readBoolean(config.enabled) ?? true,
    plugins
  };
}

module.exports = {
  getClientRuntimeStatus,
  getPluginUpdates
};
