const fs = require('fs/promises');
const path = require('path');

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function canEncrypt(safeStorage) {
  return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
}

function encryptToken(token, safeStorage) {
  const value = readString(token);
  if (!value) {
    return null;
  }
  if (!canEncrypt(safeStorage) || typeof safeStorage.encryptString !== 'function') {
    const error = new Error('当前系统不支持安全保存登录状态，请检查 Windows 凭据保护能力。');
    error.code = 'AUTH_SAFE_STORAGE_UNAVAILABLE';
    throw error;
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decryptToken(encryptedToken, safeStorage) {
  const value = readString(encryptedToken);
  if (!value || !canEncrypt(safeStorage) || typeof safeStorage.decryptString !== 'function') {
    return null;
  }
  try {
    return readString(safeStorage.decryptString(Buffer.from(value, 'base64')));
  } catch {
    return null;
  }
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

function sanitizeUser(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    return null;
  }
  const jiraDefaults = user.jiraDefaults && typeof user.jiraDefaults === 'object' ? user.jiraDefaults : {};
  return {
    id: readString(user.id),
    username: readString(user.username),
    displayName: readString(user.displayName) || readString(user.username),
    status: readString(user.status) || 'active',
    jiraDefaults: {
      defaultProjectKey: readString(jiraDefaults.defaultProjectKey),
      username: readString(jiraDefaults.username)
    }
  };
}

function createAuthStore({ userDataPath, safeStorage } = {}) {
  if (!userDataPath) {
    throw new Error('userDataPath is required.');
  }
  const authPath = path.join(userDataPath, 'auth.json');

  async function getSession() {
    const stored = await readJson(authPath, {});
    return {
      user: sanitizeUser(stored.user),
      token: decryptToken(stored.tokenEncrypted, safeStorage),
      serverUrl: readString(stored.serverUrl),
      savedAt: readString(stored.savedAt)
    };
  }

  async function saveSession({ token, user, serverUrl } = {}) {
    const session = {
      user: sanitizeUser(user),
      tokenEncrypted: encryptToken(token, safeStorage),
      serverUrl: readString(serverUrl),
      savedAt: new Date().toISOString()
    };
    await writeJson(authPath, session);
    return { user: session.user, serverUrl: session.serverUrl, savedAt: session.savedAt };
  }

  async function clearSession() {
    await writeJson(authPath, {});
    return { cleared: true };
  }

  return {
    getSession,
    saveSession,
    clearSession
  };
}

module.exports = {
  createAuthStore
};
