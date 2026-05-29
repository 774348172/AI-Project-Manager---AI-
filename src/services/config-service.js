const path = require('path');
const YAML = require('yaml');
const paths = require('../config/paths');
const { readTextIfExists } = require('../lib/file-store');

async function getGlobalConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const [markdown, yamlText] = await Promise.all([
    readTextIfExists(path.join(baizeRoot, 'config', 'global.md')),
    readTextIfExists(path.join(baizeRoot, 'config', 'global.yaml'))
  ]);

  return {
    markdown,
    config: yamlText.trim() === '' ? {} : YAML.parse(yamlText)
  };
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function readPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, readString(item)])
    .filter(([key, item]) => readString(key) && item));
}

async function readYamlConfig(filePath) {
  const yamlText = await readTextIfExists(filePath);
  return yamlText.trim() === '' ? {} : YAML.parse(yamlText) || {};
}

async function getClaudeConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const fileConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'claude.yaml'));
  const claudeConfig = fileConfig.claude && typeof fileConfig.claude === 'object' ? fileConfig.claude : {};
  const chatConfig = fileConfig.chat && typeof fileConfig.chat === 'object' ? fileConfig.chat : {};
  const envApiKey = readString(process.env.ANTHROPIC_API_KEY);
  const authToken = readString(process.env.ANTHROPIC_AUTH_TOKEN) || readString(fileConfig.authToken) || readString(claudeConfig.authToken) || null;

  return {
    provider: readString(process.env.BAIZE_CHAT_PROVIDER) || readString(fileConfig.provider) || readString(chatConfig.provider) || null,
    enabled: readBoolean(fileConfig.enabled) ?? readBoolean(claudeConfig.enabled),
    apiKey: envApiKey || (authToken ? null : readString(fileConfig.apiKey) || readString(claudeConfig.apiKey) || null),
    authToken,
    baseURL: readString(process.env.ANTHROPIC_BASE_URL) || readString(process.env.BAIZE_CLAUDE_BASE_URL) || readString(fileConfig.baseURL) || readString(fileConfig.baseUrl) || readString(fileConfig.apiURL) || readString(fileConfig.apiUrl) || readString(claudeConfig.baseURL) || readString(claudeConfig.baseUrl) || readString(claudeConfig.apiURL) || readString(claudeConfig.apiUrl) || null,
    model: readString(process.env.BAIZE_CLAUDE_MODEL) || readString(fileConfig.model) || readString(claudeConfig.model) || null
  };
}

async function getJiraConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const fileConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'jira.yaml'));
  const jiraConfig = fileConfig.jira && typeof fileConfig.jira === 'object' ? fileConfig.jira : fileConfig;
  const defaults = jiraConfig.defaults && typeof jiraConfig.defaults === 'object' ? jiraConfig.defaults : {};
  const fields = jiraConfig.fields && typeof jiraConfig.fields === 'object' ? jiraConfig.fields : {};

  return {
    enabled: readBoolean(jiraConfig.enabled) ?? false,
    baseURL: readString(process.env.BAIZE_JIRA_BASE_URL) || readString(jiraConfig.baseURL) || readString(jiraConfig.baseUrl) || null,
    deploymentType: readString(jiraConfig.deploymentType) || 'server',
    apiVersion: readString(jiraConfig.apiVersion) || '2',
    authType: readString(jiraConfig.authType) || 'basic',
    email: readString(process.env.BAIZE_JIRA_EMAIL) || readString(jiraConfig.email) || null,
    username: readString(process.env.BAIZE_JIRA_USERNAME) || readString(jiraConfig.username) || null,
    password: readString(process.env.BAIZE_JIRA_PASSWORD) || readString(jiraConfig.password) || null,
    apiToken: readString(process.env.BAIZE_JIRA_API_TOKEN) || readString(jiraConfig.apiToken) || readString(jiraConfig.token) || null,
    defaultProjectKey: readString(defaults.projectKey) || readString(jiraConfig.defaultProjectKey) || null,
    defaultIssueType: readString(defaults.issueType) || readString(jiraConfig.defaultIssueType) || 'Task',
    fieldMappings: readStringMap(fields)
  };
}

function toPublicJiraConfig(config) {
  const fieldMappings = config.fieldMappings || {};
  return {
    enabled: config.enabled,
    baseURL: config.baseURL,
    deploymentType: config.deploymentType,
    apiVersion: config.apiVersion,
    authType: config.authType,
    credentialConfigured: Boolean((config.authType === 'bearer' && config.apiToken) || (config.authType === 'basic' && (config.username || config.email) && (config.password || config.apiToken))),
    defaultProjectKey: config.defaultProjectKey,
    defaultIssueType: config.defaultIssueType,
    fieldMappings,
    fieldMappingsConfigured: Object.keys(fieldMappings).length > 0
  };
}

async function getPublicJiraConfig(options) {
  return toPublicJiraConfig(await getJiraConfig(options));
}

async function getClaudeCodeConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const fileConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'claude-code.yaml'));
  const routingConfig = fileConfig.routing && typeof fileConfig.routing === 'object' ? fileConfig.routing : {};
  const permissionsConfig = fileConfig.permissions && typeof fileConfig.permissions === 'object' ? fileConfig.permissions : {};
  const securityConfig = fileConfig.security && typeof fileConfig.security === 'object' ? fileConfig.security : {};
  const svnConfig = fileConfig.svn && typeof fileConfig.svn === 'object' ? fileConfig.svn : {};

  return {
    enabled: readBoolean(fileConfig.enabled) ?? false,
    command: readString(fileConfig.command) || 'claude',
    timeoutMs: readPositiveInteger(fileConfig.timeoutMs) || 300000,
    bugAnalysisTimeoutMs: readPositiveInteger(fileConfig.bugAnalysisTimeoutMs) || 3600000,
    bugAnalysisModel: readString(process.env.BAIZE_CLAUDE_CODE_BUG_ANALYSIS_MODEL) || readString(fileConfig.bugAnalysisModel) || 'claude-opus-4-7',
    settingsPath: readString(process.env.BAIZE_CLAUDE_CODE_SETTINGS_PATH) || readString(fileConfig.settingsPath) || null,
    workspacePath: readString(process.env.BAIZE_CLAUDE_CODE_WORKSPACE_PATH) || readString(fileConfig.workspacePath) || null,
    bugAnalysisWorkspacePath: readString(process.env.BAIZE_CLAUDE_CODE_BUG_ANALYSIS_WORKSPACE_PATH) || readString(fileConfig.bugAnalysisWorkspacePath) || null,
    claudeHomePath: readString(process.env.BAIZE_CLAUDE_CODE_HOME_PATH) || readString(fileConfig.claudeHomePath) || null,
    svn: {
      username: readString(process.env.BAIZE_SVN_USERNAME) || readString(svnConfig.username) || null,
      password: readString(process.env.BAIZE_SVN_PASSWORD) || readString(svnConfig.password) || null
    },
    env: readStringMap(fileConfig.env),
    routing: {
      autoDetectEngineeringTasks: readBoolean(routingConfig.autoDetectEngineeringTasks) ?? true
    },
    permissions: {
      defaultMode: readString(permissionsConfig.defaultMode) || 'read_only',
      requireConfirmation: readBoolean(permissionsConfig.requireConfirmation) ?? true
    },
    security: {
      denySecretFiles: readBoolean(securityConfig.denySecretFiles) ?? true,
      denyOutsideWorkspace: readBoolean(securityConfig.denyOutsideWorkspace) ?? true,
      requireConfirmationForWrites: readBoolean(securityConfig.requireConfirmationForWrites) ?? true,
      requireConfirmationForCommands: readBoolean(securityConfig.requireConfirmationForCommands) ?? true,
      denyDestructiveGit: readBoolean(securityConfig.denyDestructiveGit) ?? true,
      denyDependencyInstall: readBoolean(securityConfig.denyDependencyInstall) ?? true
    }
  };
}

function toPublicClaudeConfig(config) {
  return {
    provider: config.provider,
    enabled: config.enabled,
    apiKeyConfigured: Boolean(config.apiKey || config.authToken),
    baseURL: config.baseURL,
    model: config.model
  };
}

async function getPublicClaudeConfig(options) {
  return toPublicClaudeConfig(await getClaudeConfig(options));
}

function toPublicClaudeCodeConfig(config) {
  return {
    enabled: config.enabled,
    workspaceConfigured: Boolean(config.workspacePath),
    bugAnalysisWorkspaceConfigured: Boolean(config.bugAnalysisWorkspacePath),
    routing: {
      autoDetectEngineeringTasks: config.routing.autoDetectEngineeringTasks
    },
    permissions: {
      defaultMode: config.permissions.defaultMode,
      requireConfirmation: config.permissions.requireConfirmation
    }
  };
}

async function getPublicClaudeCodeConfig(options) {
  return toPublicClaudeCodeConfig(await getClaudeCodeConfig(options));
}

module.exports = {
  getGlobalConfig,
  getClaudeConfig,
  getPublicClaudeConfig,
  getJiraConfig,
  getPublicJiraConfig,
  getClaudeCodeConfig,
  getPublicClaudeCodeConfig
};
