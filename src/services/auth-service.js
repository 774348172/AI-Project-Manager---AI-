const crypto = require('crypto');
const { promisify } = require('util');
const path = require('path');
const paths = require('../config/paths');
const { readJsonIfExists, writeJson } = require('../lib/file-store');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;

function getAccountPaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'runtime', 'accounts');
  return {
    root,
    usersFile: path.join(root, 'users.json'),
    sessionsFile: path.join(root, 'sessions.json')
  };
}

function publicError(message, code = 'VALIDATION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function unauthorized(message = '请先登录白泽账号。') {
  return publicError(message, 'UNAUTHORIZED', 401);
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeUsername(value) {
  const username = readString(value);
  if (!username || username.length < 3 || username.length > 32 || !/^[A-Za-z0-9_-]+$/.test(username)) {
    throw publicError('用户名只能使用 3-32 位字母、数字、下划线或短横线。');
  }
  return username;
}

function normalizePassword(value) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 64) {
    throw publicError('密码长度必须是 6-64 位。');
  }
  return value;
}

function normalizePlatform(value) {
  const platform = readString(value) || 'unknown';
  return platform.length > 32 ? platform.slice(0, 32) : platform;
}

function normalizeDeviceId(value) {
  const deviceId = readString(value);
  return deviceId && deviceId.length <= 120 ? deviceId : null;
}

function normalizeClientVersion(value) {
  const version = readString(value);
  return version && version.length <= 40 ? version : null;
}

function normalizeJiraDefaultProjectKey(value) {
  const projectKey = readString(value);
  if (!projectKey) {
    return null;
  }
  if (projectKey.length > 64 || !/^[A-Za-z0-9_-]+$/.test(projectKey)) {
    throw publicError('Jira 默认项目 Key 只能使用 1-64 位字母、数字、下划线或短横线。');
  }
  return projectKey.toUpperCase();
}

function normalizeJiraUsername(value) {
  const username = readString(value);
  if (!username) {
    return null;
  }
  if (username.length > 120) {
    throw publicError('Jira 用户名长度不能超过 120 位。');
  }
  return username;
}

function normalizeJiraDefaults(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    defaultProjectKey: normalizeJiraDefaultProjectKey(source.defaultProjectKey),
    username: normalizeJiraUsername(source.username)
  };
}

function toPublicJiraDefaults(value = {}) {
  const defaults = value && typeof value === 'object' ? value : {};
  return {
    defaultProjectKey: readString(defaults.defaultProjectKey) || null,
    username: readString(defaults.username) || null
  };
}

async function readUsers({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const accountPaths = getAccountPaths(baizeRoot);
  const payload = await readJsonIfExists(accountPaths.usersFile, { users: [] });
  return Array.isArray(payload.users) ? payload.users : [];
}

async function writeUsers(users, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const accountPaths = getAccountPaths(baizeRoot);
  await writeJson(accountPaths.usersFile, { users }, accountPaths.root);
}

async function readSessions({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const accountPaths = getAccountPaths(baizeRoot);
  const payload = await readJsonIfExists(accountPaths.sessionsFile, { sessions: [] });
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

async function writeSessions(sessions, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const accountPaths = getAccountPaths(baizeRoot);
  await writeJson(accountPaths.sessionsFile, { sessions }, accountPaths.root);
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  return `scrypt:${salt}:${hash.toString('base64')}`;
}

async function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const expected = Buffer.from(parts[2], 'base64');
  const actual = await scrypt(password, parts[1], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    status: user.status || 'active',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
    jiraDefaults: toPublicJiraDefaults(user.jiraDefaults)
  };
}

function normalizeSessionInput(input = {}) {
  return {
    platform: normalizePlatform(input.platform),
    deviceId: normalizeDeviceId(input.deviceId),
    clientVersion: normalizeClientVersion(input.clientVersion)
  };
}

async function createSession(user, input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionInput = normalizeSessionInput(input);
  const timestamp = nowIso(now);
  const session = {
    id: `session-${crypto.randomUUID()}`,
    userId: user.id,
    tokenHash: tokenHash(token),
    platform: sessionInput.platform,
    deviceId: sessionInput.deviceId,
    clientVersion: sessionInput.clientVersion,
    createdAt: timestamp,
    expiresAt: nowIso(new Date(now.getTime() + SESSION_TTL_MS)),
    lastSeenAt: timestamp
  };
  const sessions = await readSessions({ baizeRoot });
  await writeSessions([...sessions.filter((item) => new Date(item.expiresAt).getTime() > now.getTime()), session], { baizeRoot });
  return { token, session };
}

async function registerUser(input = {}, options = {}) {
  const username = normalizeUsername(input.username);
  const password = normalizePassword(input.password);
  const displayName = readString(input.displayName) || username;
  const canonicalUsername = username.toLowerCase();
  const users = await readUsers(options);
  if (users.some((user) => user.canonicalUsername === canonicalUsername)) {
    throw publicError('用户名已存在。', 'USERNAME_TAKEN', 409);
  }

  const timestamp = nowIso(options.now || new Date());
  const user = {
    id: `user-${crypto.randomUUID()}`,
    username,
    canonicalUsername,
    displayName: displayName.slice(0, 40),
    passwordHash: await hashPassword(password),
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoginAt: timestamp
  };
  await writeUsers([...users, user], options);
  const { token, session } = await createSession(user, input, options);
  return { user: toPublicUser(user), token, session };
}

async function loginUser(input = {}, options = {}) {
  const username = normalizeUsername(input.username);
  const password = normalizePassword(input.password);
  const users = await readUsers(options);
  const user = users.find((item) => item.canonicalUsername === username.toLowerCase());
  if (!user || user.status === 'disabled' || !(await verifyPassword(password, user.passwordHash))) {
    throw publicError('账号或密码错误。', 'INVALID_CREDENTIALS', 401);
  }

  const timestamp = nowIso(options.now || new Date());
  const updatedUser = { ...user, lastLoginAt: timestamp, updatedAt: timestamp };
  await writeUsers(users.map((item) => item.id === user.id ? updatedUser : item), options);
  const { token, session } = await createSession(updatedUser, input, options);
  return { user: toPublicUser(updatedUser), token, session };
}

async function authenticateToken(token, options = {}) {
  const rawToken = readString(token);
  if (!rawToken) {
    throw unauthorized();
  }

  const now = options.now || new Date();
  const hash = tokenHash(rawToken);
  const sessions = await readSessions(options);
  const activeSessions = sessions.filter((session) => new Date(session.expiresAt).getTime() > now.getTime());
  const session = activeSessions.find((item) => item.tokenHash === hash);
  if (!session) {
    if (activeSessions.length !== sessions.length) {
      await writeSessions(activeSessions, options);
    }
    throw unauthorized('登录状态已失效，请重新登录。');
  }

  const users = await readUsers(options);
  const user = users.find((item) => item.id === session.userId);
  if (!user || user.status === 'disabled') {
    throw unauthorized('账号不可用，请重新登录。');
  }

  const updatedSession = { ...session, lastSeenAt: nowIso(now) };
  await writeSessions(activeSessions.map((item) => item.id === session.id ? updatedSession : item), options);
  return { user: toPublicUser(user), session: updatedSession };
}

async function logoutToken(token, options = {}) {
  const rawToken = readString(token);
  if (!rawToken) {
    return { loggedOut: false };
  }
  const hash = tokenHash(rawToken);
  const sessions = await readSessions(options);
  const nextSessions = sessions.filter((session) => session.tokenHash !== hash);
  await writeSessions(nextSessions, options);
  return { loggedOut: nextSessions.length !== sessions.length };
}

async function updateUserJiraDefaults(userId, input = {}, options = {}) {
  const id = readString(userId);
  if (!id) {
    throw unauthorized();
  }
  const users = await readUsers(options);
  const user = users.find((item) => item.id === id);
  if (!user || user.status === 'disabled') {
    throw unauthorized('账号不可用，请重新登录。');
  }
  const source = input && typeof input === 'object' && input.jiraDefaults && typeof input.jiraDefaults === 'object'
    ? input.jiraDefaults
    : input;
  const updatedUser = {
    ...user,
    jiraDefaults: normalizeJiraDefaults(source),
    updatedAt: nowIso(options.now || new Date())
  };
  await writeUsers(users.map((item) => item.id === id ? updatedUser : item), options);
  return { user: toPublicUser(updatedUser) };
}

module.exports = {
  SESSION_TTL_MS,
  authenticateToken,
  getAccountPaths,
  loginUser,
  logoutToken,
  registerUser,
  toPublicUser,
  unauthorized,
  updateUserJiraDefaults
};
