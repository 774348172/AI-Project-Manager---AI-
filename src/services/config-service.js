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

function readBooleanString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  return null;
}

function readPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readString).filter(Boolean);
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

async function getSpeechConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const fileConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'speech.yaml'));
  const speechConfig = fileConfig.speech && typeof fileConfig.speech === 'object' ? fileConfig.speech : fileConfig;
  const xunfeiConfig = speechConfig.xunfei && typeof speechConfig.xunfei === 'object' ? speechConfig.xunfei : {};

  return {
    provider: readString(process.env.BAIZE_SPEECH_PROVIDER) || readString(speechConfig.provider) || 'placeholder',
    xunfei: {
      appId: readString(process.env.BAIZE_XUNFEI_APP_ID) || readString(xunfeiConfig.appId) || null,
      apiKey: readString(process.env.BAIZE_XUNFEI_API_KEY) || readString(xunfeiConfig.apiKey) || null,
      apiSecret: readString(process.env.BAIZE_XUNFEI_API_SECRET) || readString(xunfeiConfig.apiSecret) || null
    }
  };
}

async function getWeComConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const fileConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'wecom.yaml'));
  const wecomConfig = fileConfig.wecom && typeof fileConfig.wecom === 'object' ? fileConfig.wecom : fileConfig;
  const replyConfig = wecomConfig.reply && typeof wecomConfig.reply === 'object' ? wecomConfig.reply : {};
  const aiBotConfig = wecomConfig.aiBot && typeof wecomConfig.aiBot === 'object' ? wecomConfig.aiBot : {};
  const aiBotReplyConfig = aiBotConfig.reply && typeof aiBotConfig.reply === 'object' ? aiBotConfig.reply : {};

  return {
    enabled: readBooleanString(process.env.BAIZE_WECOM_ENABLED) ?? readBoolean(wecomConfig.enabled) ?? false,
    corpId: readString(process.env.BAIZE_WECOM_CORP_ID) || readString(wecomConfig.corpId) || null,
    agentId: readString(process.env.BAIZE_WECOM_AGENT_ID) || readString(wecomConfig.agentId) || null,
    secret: readString(process.env.BAIZE_WECOM_SECRET) || readString(wecomConfig.secret) || null,
    token: readString(process.env.BAIZE_WECOM_TOKEN) || readString(wecomConfig.token) || null,
    encodingAESKey: readString(process.env.BAIZE_WECOM_ENCODING_AES_KEY) || readString(wecomConfig.encodingAESKey) || null,
    reply: {
      enabled: readBooleanString(process.env.BAIZE_WECOM_REPLY_ENABLED) ?? readBoolean(replyConfig.enabled) ?? true
    },
    aiBot: {
      enabled: readBooleanString(process.env.BAIZE_WECOM_AI_BOT_ENABLED) ?? readBoolean(aiBotConfig.enabled) ?? false,
      botId: readString(process.env.BAIZE_WECOM_AI_BOT_ID) || readString(aiBotConfig.botId) || null,
      secret: readString(process.env.BAIZE_WECOM_AI_BOT_SECRET) || readString(aiBotConfig.secret) || null,
      wsUrl: readString(process.env.BAIZE_WECOM_AI_BOT_WS_URL) || readString(aiBotConfig.wsUrl) || null,
      notifyChatId: readString(process.env.BAIZE_WECOM_AI_BOT_NOTIFY_CHAT_ID) || readString(aiBotConfig.notifyChatId) || readString(aiBotConfig.defaultChatId) || null,
      reply: {
        enabled: readBooleanString(process.env.BAIZE_WECOM_AI_BOT_REPLY_ENABLED) ?? readBoolean(aiBotReplyConfig.enabled) ?? true
      }
    }
  };
}

function toPublicWeComConfig(config) {
  return {
    enabled: config.enabled,
    corpIdConfigured: Boolean(config.corpId),
    agentIdConfigured: Boolean(config.agentId),
    secretConfigured: Boolean(config.secret),
    tokenConfigured: Boolean(config.token),
    encodingAESKeyConfigured: Boolean(config.encodingAESKey),
    reply: {
      enabled: config.reply.enabled
    },
    aiBot: {
      enabled: config.aiBot.enabled,
      botConfigured: Boolean(config.aiBot.botId && config.aiBot.secret),
      wsUrlConfigured: Boolean(config.aiBot.wsUrl),
      notifyChatConfigured: Boolean(config.aiBot.notifyChatId),
      reply: {
        enabled: config.aiBot.reply.enabled
      }
    }
  };
}

async function getPublicWeComConfig(options) {
  return toPublicWeComConfig(await getWeComConfig(options));
}

async function getUnityBuildConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const fileConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'unity-build.yaml'));
  const claudeCodeConfig = await readYamlConfig(path.join(baizeRoot, 'config', 'claude-code.yaml'));
  const unityConfig = fileConfig.unityBuild && typeof fileConfig.unityBuild === 'object' ? fileConfig.unityBuild : fileConfig;
  const svnConfig = unityConfig.svn && typeof unityConfig.svn === 'object' ? unityConfig.svn : {};
  const unityMcpConfig = unityConfig.unityMcp && typeof unityConfig.unityMcp === 'object' ? unityConfig.unityMcp : {};
  const notifyConfig = unityConfig.notify && typeof unityConfig.notify === 'object' ? unityConfig.notify : {};

  return {
    enabled: readBooleanString(process.env.BAIZE_UNITY_BUILD_ENABLED) ?? readBoolean(unityConfig.enabled) ?? false,
    intervalMinutes: readPositiveInteger(Number(process.env.BAIZE_UNITY_BUILD_INTERVAL_MINUTES)) || readPositiveInteger(unityConfig.intervalMinutes) || 60,
    runOnServerStart: readBooleanString(process.env.BAIZE_UNITY_BUILD_RUN_ON_SERVER_START) ?? readBoolean(unityConfig.runOnServerStart) ?? false,
    workspacePath: readString(process.env.BAIZE_UNITY_BUILD_WORKSPACE_PATH) || readString(unityConfig.workspacePath) || readString(process.env.BAIZE_CLAUDE_CODE_BUG_ANALYSIS_WORKSPACE_PATH) || readString(claudeCodeConfig.bugAnalysisWorkspacePath) || null,
    svn: {
      enabled: readBooleanString(process.env.BAIZE_UNITY_BUILD_SVN_ENABLED) ?? readBoolean(svnConfig.enabled) ?? true,
      username: readString(process.env.BAIZE_SVN_USERNAME) || readString(svnConfig.username) || null,
      password: readString(process.env.BAIZE_SVN_PASSWORD) || readString(svnConfig.password) || null,
      updateArgs: readStringArray(svnConfig.updateArgs).length > 0 ? readStringArray(svnConfig.updateArgs) : ['update', '--accept', 'theirs-full']
    },
    unityMcp: {
      command: readString(process.env.BAIZE_UNITY_MCP_COMMAND) || readString(unityMcpConfig.command) || null,
      args: readStringArray(unityMcpConfig.args),
      timeoutMs: readPositiveInteger(Number(process.env.BAIZE_UNITY_MCP_TIMEOUT_MS)) || readPositiveInteger(unityMcpConfig.timeoutMs) || 1800000
    },
    notify: {
      enabled: readBooleanString(process.env.BAIZE_UNITY_BUILD_NOTIFY_ENABLED) ?? readBoolean(notifyConfig.enabled) ?? true,
      webhookUrl: readString(process.env.BAIZE_WECOM_BOT_WEBHOOK_URL) || readString(notifyConfig.webhookUrl) || null,
      toUser: readString(process.env.BAIZE_WECOM_UNITY_BUILD_TO_USER) || readString(notifyConfig.toUser) || null,
      aiBotChatId: readString(process.env.BAIZE_WECOM_AI_BOT_NOTIFY_CHAT_ID) || readString(notifyConfig.aiBotChatId) || null
    }
  };
}

function toPublicUnityBuildConfig(config) {
  return {
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    runOnServerStart: config.runOnServerStart,
    workspaceConfigured: Boolean(config.workspacePath),
    svn: {
      enabled: config.svn.enabled,
      credentialConfigured: Boolean(config.svn.username || config.svn.password)
    },
    unityMcp: {
      commandConfigured: Boolean(config.unityMcp.command),
      timeoutMs: config.unityMcp.timeoutMs
    },
    notify: {
      enabled: config.notify.enabled,
      webhookConfigured: Boolean(config.notify.webhookUrl),
      appReceiverConfigured: Boolean(config.notify.toUser),
      aiBotReceiverConfigured: Boolean(config.notify.aiBotChatId)
    }
  };
}

async function getPublicUnityBuildConfig(options) {
  return toPublicUnityBuildConfig(await getUnityBuildConfig(options));
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
    requirementCompletionWorkspacePath: readString(process.env.BAIZE_CLAUDE_CODE_REQUIREMENT_COMPLETION_WORKSPACE_PATH) || readString(fileConfig.requirementCompletionWorkspacePath) || readString(fileConfig.bugAnalysisWorkspacePath) || null,
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
    requirementCompletionWorkspaceConfigured: Boolean(config.requirementCompletionWorkspacePath),
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
  getSpeechConfig,
  getWeComConfig,
  getPublicWeComConfig,
  getUnityBuildConfig,
  getPublicUnityBuildConfig,
  getClaudeCodeConfig,
  getPublicClaudeCodeConfig
};
