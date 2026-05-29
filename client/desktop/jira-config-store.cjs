const fs = require('fs/promises');
const path = require('path');

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, readString(item)])
    .filter(([key, item]) => readString(key) && item));
}

function getJiraConfigPath(userDataPath) {
  return path.join(userDataPath, 'jira.local.json');
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim() === '' ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function canEncrypt(safeStorage) {
  return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
}

function encryptSecret(value, safeStorage) {
  const text = readString(value);
  if (!text) {
    return null;
  }
  if (!canEncrypt(safeStorage) || typeof safeStorage.encryptString !== 'function') {
    const error = new Error('当前系统不支持安全保存 Jira 密钥，请改用本机环境变量配置。');
    error.code = 'JIRA_SAFE_STORAGE_UNAVAILABLE';
    throw error;
  }
  return safeStorage.encryptString(text).toString('base64');
}

function decryptSecret(value, safeStorage) {
  const text = readString(value);
  if (!text) {
    return null;
  }
  if (!canEncrypt(safeStorage) || typeof safeStorage.decryptString !== 'function') {
    return null;
  }
  try {
    return readString(safeStorage.decryptString(Buffer.from(text, 'base64')));
  } catch {
    return null;
  }
}

function readEnvConfig(env = process.env) {
  return {
    baseURL: readString(env.BAIZE_DESKTOP_JIRA_BASE_URL),
    deploymentType: readString(env.BAIZE_DESKTOP_JIRA_DEPLOYMENT_TYPE),
    apiVersion: readString(env.BAIZE_DESKTOP_JIRA_API_VERSION),
    authType: readString(env.BAIZE_DESKTOP_JIRA_AUTH_TYPE),
    email: readString(env.BAIZE_DESKTOP_JIRA_EMAIL),
    username: readString(env.BAIZE_DESKTOP_JIRA_USERNAME),
    password: readString(env.BAIZE_DESKTOP_JIRA_PASSWORD),
    apiToken: readString(env.BAIZE_DESKTOP_JIRA_API_TOKEN),
    defaultProjectKey: readString(env.BAIZE_DESKTOP_JIRA_DEFAULT_PROJECT_KEY),
    defaultIssueType: readString(env.BAIZE_DESKTOP_JIRA_DEFAULT_ISSUE_TYPE)
  };
}

function mergeJiraConfig(publicConfig = {}, localConfig = {}, envConfig = {}, runtimeConfig = {}) {
  return {
    enabled: true,
    baseURL: envConfig.baseURL || readString(runtimeConfig.baseURL) || readString(localConfig.baseURL) || readString(publicConfig.baseURL),
    deploymentType: envConfig.deploymentType || readString(runtimeConfig.deploymentType) || readString(localConfig.deploymentType) || readString(publicConfig.deploymentType) || 'server',
    apiVersion: envConfig.apiVersion || readString(runtimeConfig.apiVersion) || readString(localConfig.apiVersion) || readString(publicConfig.apiVersion) || '2',
    authType: envConfig.authType || readString(runtimeConfig.authType) || readString(localConfig.authType) || readString(publicConfig.authType) || 'basic',
    email: envConfig.email || readString(runtimeConfig.email) || readString(localConfig.email),
    username: envConfig.username || readString(runtimeConfig.username) || readString(localConfig.username),
    password: envConfig.password || readString(runtimeConfig.password) || readString(localConfig.password),
    apiToken: envConfig.apiToken || readString(runtimeConfig.apiToken) || readString(localConfig.apiToken),
    defaultProjectKey: envConfig.defaultProjectKey || readString(runtimeConfig.defaultProjectKey) || readString(localConfig.defaultProjectKey) || readString(publicConfig.defaultProjectKey),
    defaultIssueType: envConfig.defaultIssueType || readString(runtimeConfig.defaultIssueType) || readString(localConfig.defaultIssueType) || readString(publicConfig.defaultIssueType) || 'Task',
    fieldMappings: readStringMap({
      ...readStringMap(publicConfig.fieldMappings),
      ...readStringMap(runtimeConfig.fieldMappings),
      ...readStringMap(localConfig.fieldMappings)
    })
  };
}

function hasCredentials(config = {}) {
  if (config.authType === 'bearer') {
    return Boolean(config.apiToken);
  }
  return Boolean((config.username || config.email) && (config.password || config.apiToken));
}

function toPublicConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    baseURL: config.baseURL || null,
    deploymentType: config.deploymentType || 'server',
    apiVersion: config.apiVersion || '2',
    authType: config.authType || 'basic',
    credentialConfigured: hasCredentials(config),
    defaultProjectKey: config.defaultProjectKey || null,
    defaultIssueType: config.defaultIssueType || 'Task',
    fieldMappings: readStringMap(config.fieldMappings),
    fieldMappingsConfigured: Object.keys(readStringMap(config.fieldMappings)).length > 0
  };
}

function createJiraConfigStore({ userDataPath, safeStorage, getPublicConfig, getRuntimeConfig, env = process.env } = {}) {
  if (!userDataPath) {
    throw new Error('userDataPath is required.');
  }
  const configPath = getJiraConfigPath(userDataPath);

  async function readLocalConfig() {
    const stored = await readJson(configPath, {});
    return {
      enabled: stored.enabled,
      baseURL: readString(stored.baseURL),
      deploymentType: readString(stored.deploymentType),
      apiVersion: readString(stored.apiVersion),
      authType: readString(stored.authType),
      email: readString(stored.email),
      username: readString(stored.username),
      password: decryptSecret(stored.passwordEncrypted, safeStorage),
      apiToken: decryptSecret(stored.apiTokenEncrypted, safeStorage),
      defaultProjectKey: readString(stored.defaultProjectKey),
      defaultIssueType: readString(stored.defaultIssueType),
      fieldMappings: readStringMap(stored.fieldMappings)
    };
  }

  async function getConfig() {
    const [publicConfig, localConfig, runtimeConfig] = await Promise.all([
      typeof getPublicConfig === 'function' ? getPublicConfig().catch(() => ({})) : {},
      readLocalConfig(),
      typeof getRuntimeConfig === 'function' ? getRuntimeConfig().catch(() => ({})) : {}
    ]);
    return mergeJiraConfig(publicConfig || {}, localConfig, readEnvConfig(env), runtimeConfig && runtimeConfig.jira);
  }

  async function getPublicStatus() {
    return toPublicConfig(await getConfig());
  }

  async function saveConfig(input = {}) {
    const current = await readJson(configPath, {});
    const next = {
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
      baseURL: readString(input.baseURL) || readString(current.baseURL),
      deploymentType: readString(input.deploymentType) || readString(current.deploymentType),
      apiVersion: readString(input.apiVersion) || readString(current.apiVersion),
      authType: readString(input.authType) || readString(current.authType) || 'basic',
      email: readString(input.email) || readString(current.email),
      username: readString(input.username) || readString(current.username),
      passwordEncrypted: input.password !== undefined ? encryptSecret(input.password, safeStorage) : current.passwordEncrypted,
      apiTokenEncrypted: input.apiToken !== undefined ? encryptSecret(input.apiToken, safeStorage) : current.apiTokenEncrypted,
      defaultProjectKey: readString(input.defaultProjectKey) || readString(current.defaultProjectKey),
      defaultIssueType: readString(input.defaultIssueType) || readString(current.defaultIssueType),
      fieldMappings: Object.keys(readStringMap(input.fieldMappings)).length > 0 ? readStringMap(input.fieldMappings) : readStringMap(current.fieldMappings),
      updatedAt: new Date().toISOString()
    };
    await writeJson(configPath, next);
    return getPublicStatus();
  }

  return {
    getConfig,
    getPublicStatus,
    saveConfig
  };
}

module.exports = {
  createJiraConfigStore,
  mergeJiraConfig,
  toPublicConfig,
  hasCredentials
};
