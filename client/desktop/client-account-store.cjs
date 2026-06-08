const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function getAccountPath(userDataPath) {
  return path.join(userDataPath, 'client-account.json');
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

function encryptSecret(value, safeStorage, label = '账号密钥') {
  const text = readString(value);
  if (!text) {
    return null;
  }
  if (!canEncrypt(safeStorage) || typeof safeStorage.encryptString !== 'function') {
    const error = new Error(`当前系统不支持安全保存${label}，请改用本机环境变量配置。`);
    error.code = 'CLIENT_ACCOUNT_SAFE_STORAGE_UNAVAILABLE';
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

function createMachineCode(seed = {}) {
  const source = [
    seed.hostname || os.hostname(),
    seed.platform || process.platform,
    seed.arch || process.arch,
    seed.userInfo && seed.userInfo.username ? seed.userInfo.username : os.userInfo().username
  ].filter(Boolean).join('|');
  return `machine-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

function ensureBindings(bindings = {}) {
  return {
    svn: bindings.svn && typeof bindings.svn === 'object' && !Array.isArray(bindings.svn) ? bindings.svn : {},
    jira: bindings.jira && typeof bindings.jira === 'object' && !Array.isArray(bindings.jira) ? bindings.jira : {},
    wecom: bindings.wecom && typeof bindings.wecom === 'object' && !Array.isArray(bindings.wecom) ? bindings.wecom : {}
  };
}

function normalizeAccount(account = {}, { clientId, machineCode } = {}) {
  const now = new Date().toISOString();
  return {
    clientId: readString(account.clientId) || readString(clientId) || `desktop-${crypto.randomUUID()}`,
    machineCode: readString(account.machineCode) || readString(machineCode) || createMachineCode(),
    displayName: readString(account.displayName) || os.hostname(),
    bindings: ensureBindings(account.bindings),
    createdAt: readString(account.createdAt) || now,
    updatedAt: readString(account.updatedAt) || now
  };
}

function hasJiraCredentials(jira = {}) {
  if (jira.authType === 'bearer') {
    return Boolean(readString(jira.apiTokenEncrypted));
  }
  return Boolean((readString(jira.username) || readString(jira.email)) && (readString(jira.passwordEncrypted) || readString(jira.apiTokenEncrypted)));
}

function publicBindingStatus(binding = {}, credentialKeys = []) {
  return {
    enabled: binding.enabled !== false,
    bound: credentialKeys.some((key) => Boolean(readString(binding[key]))),
    updatedAt: readString(binding.updatedAt)
  };
}

function publicAccount(account = {}) {
  const bindings = ensureBindings(account.bindings);
  return {
    clientId: account.clientId,
    machineCode: account.machineCode,
    displayName: account.displayName,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    bindings: {
      svn: {
        ...publicBindingStatus(bindings.svn, ['username', 'passwordEncrypted']),
        username: readString(bindings.svn.username),
        workspacePath: readString(bindings.svn.workspacePath),
        unityExePath: readString(bindings.svn.unityExePath),
        validationCommand: readString(bindings.svn.validationCommand),
        credentialConfigured: Boolean(readString(bindings.svn.username) || readString(bindings.svn.passwordEncrypted))
      },
      jira: {
        enabled: bindings.jira.enabled !== false,
        bound: hasJiraCredentials(bindings.jira),
        baseURL: readString(bindings.jira.baseURL),
        deploymentType: readString(bindings.jira.deploymentType) || 'server',
        apiVersion: readString(bindings.jira.apiVersion) || '2',
        authType: readString(bindings.jira.authType) || 'basic',
        email: readString(bindings.jira.email),
        username: readString(bindings.jira.username),
        defaultProjectKey: readString(bindings.jira.defaultProjectKey),
        defaultIssueType: readString(bindings.jira.defaultIssueType),
        credentialConfigured: hasJiraCredentials(bindings.jira),
        updatedAt: readString(bindings.jira.updatedAt)
      },
      wecom: {
        ...publicBindingStatus(bindings.wecom, ['userId', 'webhookUrlEncrypted', 'botWebhookUrlEncrypted']),
        userId: readString(bindings.wecom.userId),
        corpId: readString(bindings.wecom.corpId),
        credentialConfigured: Boolean(readString(bindings.wecom.webhookUrlEncrypted) || readString(bindings.wecom.botWebhookUrlEncrypted)),
        userConfigured: Boolean(readString(bindings.wecom.userId))
      }
    }
  };
}

function decryptedBinding(binding = {}, safeStorage, secretFields = []) {
  const result = { ...binding };
  for (const field of secretFields) {
    const encryptedKey = `${field}Encrypted`;
    result[field] = decryptSecret(binding[encryptedKey], safeStorage);
  }
  return result;
}

function sanitizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [readString(key), readString(item)])
    .filter(([key, item]) => key && item));
}

function createClientAccountStore({ userDataPath, safeStorage, getClientId, getMachineCode } = {}) {
  if (!userDataPath) {
    throw new Error('userDataPath is required.');
  }
  const accountPath = getAccountPath(userDataPath);

  async function readAccount() {
    const stored = await readJson(accountPath, {});
    const clientId = typeof getClientId === 'function' ? await getClientId() : null;
    const machineCode = typeof getMachineCode === 'function' ? await getMachineCode() : null;
    const account = normalizeAccount(stored, { clientId, machineCode });
    if (!stored.clientId || !stored.machineCode || !stored.bindings) {
      await writeJson(accountPath, account);
    }
    return account;
  }

  async function writeAccount(account) {
    const next = { ...account, bindings: ensureBindings(account.bindings), updatedAt: new Date().toISOString() };
    await writeJson(accountPath, next);
    return next;
  }

  async function getPublicAccount() {
    return publicAccount(await readAccount());
  }

  async function getEditableAccount() {
    const account = await readAccount();
    const result = publicAccount(account);
    const jira = ensureBindings(account.bindings).jira;
    return {
      ...result,
      bindings: {
        ...result.bindings,
        jira: {
          ...result.bindings.jira,
          apiToken: decryptSecret(jira.apiTokenEncrypted, safeStorage)
        }
      }
    };
  }

  async function saveProfile(input = {}) {
    const account = await readAccount();
    return publicAccount(await writeAccount({
      ...account,
      displayName: readString(input.displayName) || account.displayName
    }));
  }

  async function getBindingConfig(kind) {
    const account = await readAccount();
    const binding = ensureBindings(account.bindings)[kind] || {};
    if (kind === 'svn') {
      return decryptedBinding(binding, safeStorage, ['password']);
    }
    if (kind === 'jira') {
      return decryptedBinding(binding, safeStorage, ['password', 'apiToken']);
    }
    if (kind === 'wecom') {
      return decryptedBinding(binding, safeStorage, ['webhookUrl', 'botWebhookUrl']);
    }
    return {};
  }

  async function saveSvnBinding(input = {}) {
    const account = await readAccount();
    const current = ensureBindings(account.bindings).svn;
    const next = {
      enabled: input.enabled !== undefined ? input.enabled !== false : current.enabled !== false,
      username: input.username !== undefined ? readString(input.username) : readString(current.username),
      workspacePath: input.workspacePath !== undefined ? readString(input.workspacePath) : readString(current.workspacePath),
      unityExePath: input.unityExePath !== undefined ? readString(input.unityExePath) : readString(current.unityExePath),
      validationCommand: input.validationCommand !== undefined ? readString(input.validationCommand) : readString(current.validationCommand),
      passwordEncrypted: input.password !== undefined ? encryptSecret(input.password, safeStorage, 'SVN 密码') : current.passwordEncrypted,
      updatedAt: new Date().toISOString()
    };
    return publicAccount(await writeAccount({ ...account, bindings: { ...ensureBindings(account.bindings), svn: next } }));
  }

  async function saveJiraBinding(input = {}) {
    const account = await readAccount();
    const current = ensureBindings(account.bindings).jira;
    const next = {
      enabled: input.enabled !== undefined ? input.enabled !== false : current.enabled !== false,
      baseURL: input.baseURL !== undefined ? readString(input.baseURL) : readString(current.baseURL),
      deploymentType: input.deploymentType !== undefined ? readString(input.deploymentType) : readString(current.deploymentType),
      apiVersion: input.apiVersion !== undefined ? readString(input.apiVersion) : readString(current.apiVersion),
      authType: input.authType !== undefined ? readString(input.authType) : readString(current.authType) || 'basic',
      email: input.email !== undefined ? readString(input.email) : readString(current.email),
      username: input.username !== undefined ? readString(input.username) : readString(current.username),
      passwordEncrypted: input.password !== undefined ? encryptSecret(input.password, safeStorage, 'Jira 密码') : current.passwordEncrypted,
      apiTokenEncrypted: input.apiToken !== undefined ? encryptSecret(input.apiToken, safeStorage, 'Jira Token') : current.apiTokenEncrypted,
      defaultProjectKey: input.defaultProjectKey !== undefined ? readString(input.defaultProjectKey) : readString(current.defaultProjectKey),
      defaultIssueType: input.defaultIssueType !== undefined ? readString(input.defaultIssueType) : readString(current.defaultIssueType),
      fieldMappings: Object.keys(sanitizeStringMap(input.fieldMappings)).length > 0 ? sanitizeStringMap(input.fieldMappings) : sanitizeStringMap(current.fieldMappings),
      updatedAt: new Date().toISOString()
    };
    return publicAccount(await writeAccount({ ...account, bindings: { ...ensureBindings(account.bindings), jira: next } }));
  }

  async function saveWeComBinding(input = {}) {
    const account = await readAccount();
    const current = ensureBindings(account.bindings).wecom;
    const next = {
      enabled: input.enabled !== undefined ? input.enabled !== false : current.enabled !== false,
      userId: input.userId !== undefined ? readString(input.userId) : readString(current.userId),
      corpId: input.corpId !== undefined ? readString(input.corpId) : readString(current.corpId),
      webhookUrlEncrypted: input.webhookUrl !== undefined ? encryptSecret(input.webhookUrl, safeStorage, '企业微信 Webhook') : current.webhookUrlEncrypted,
      botWebhookUrlEncrypted: input.botWebhookUrl !== undefined ? encryptSecret(input.botWebhookUrl, safeStorage, '企业微信机器人 Webhook') : current.botWebhookUrlEncrypted,
      updatedAt: new Date().toISOString()
    };
    return publicAccount(await writeAccount({ ...account, bindings: { ...ensureBindings(account.bindings), wecom: next } }));
  }

  return {
    getPublicAccount,
    getEditableAccount,
    saveProfile,
    getBindingConfig,
    saveSvnBinding,
    saveJiraBinding,
    saveWeComBinding
  };
}

module.exports = {
  createClientAccountStore,
  createMachineCode,
  publicAccount
};
