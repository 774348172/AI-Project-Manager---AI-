const fs = require('fs/promises');
const path = require('path');
const YAML = require('yaml');
const paths = require('../config/paths');
const { ensureInside, readTextIfExists } = require('../lib/file-store');

function clientVersionError(message, code = 'CLIENT_VERSION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function readClientVersionConfig({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const yamlText = await readTextIfExists(path.join(baizeRoot, 'config', 'client-version.yaml'));
  const config = yamlText.trim() === '' ? {} : YAML.parse(yamlText) || {};
  const windows = readObject(config.windows);
  return {
    enabled: readBoolean(config.enabled) ?? false,
    currentVersion: readString(config.currentVersion) || null,
    minimumVersion: readString(config.minimumVersion) || null,
    releaseNotes: readString(config.releaseNotes) || '',
    forceUpdate: readBoolean(config.forceUpdate) ?? false,
    windows: {
      updateDir: readString(windows.updateDir) || path.join(baizeRoot, 'client-updates', 'windows'),
      latestYml: readString(windows.latestYml) || 'latest.yml',
      installer: readString(windows.installer) || '白泽.exe',
      blockMap: readString(windows.blockMap) || '白泽.exe.blockmap'
    }
  };
}

function compareVersion(a, b) {
  const left = String(a || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function buildPublicVersionStatus(config, { version, platform = 'windows', serverBaseUrl = '' } = {}) {
  if (platform !== 'windows') {
    throw clientVersionError('当前只支持 Windows 客户端更新。');
  }

  const clientVersion = readString(version) || '0.0.0';
  const currentVersion = config.currentVersion || clientVersion;
  const minimumVersion = config.minimumVersion || currentVersion;
  const updateAvailable = config.enabled && compareVersion(currentVersion, clientVersion) > 0;
  const updateRequired = config.enabled && (compareVersion(minimumVersion, clientVersion) > 0 || (config.forceUpdate && updateAvailable));
  const updateBaseUrl = `${serverBaseUrl.replace(/\/$/, '')}/client-updates/windows`;

  return {
    enabled: config.enabled,
    platform: 'windows',
    currentVersion,
    clientVersion,
    minimumVersion,
    updateAvailable,
    updateRequired,
    forceUpdate: config.forceUpdate,
    releaseNotes: config.releaseNotes,
    updateUrl: config.enabled ? updateBaseUrl : null,
    latestYmlUrl: config.enabled ? `${updateBaseUrl}/${encodeURIComponent(config.windows.latestYml)}` : null
  };
}

async function getClientVersionStatus(input = {}, options = {}) {
  const config = await readClientVersionConfig(options);
  return buildPublicVersionStatus(config, input);
}

function getAllowedUpdateFiles(config) {
  return new Set([config.windows.latestYml, config.windows.installer, config.windows.blockMap].filter(Boolean));
}

async function getClientUpdateFile(fileName, options = {}) {
  const config = await readClientVersionConfig(options);
  if (!config.enabled) {
    throw clientVersionError('客户端版本管理未启用。', 'CLIENT_UPDATE_DISABLED', 404);
  }

  const safeFileName = readString(fileName);
  if (!safeFileName || safeFileName.includes('/') || safeFileName.includes('\\') || safeFileName.includes('..')) {
    throw clientVersionError('客户端更新文件名无效。', 'INVALID_UPDATE_FILE', 400);
  }
  if (!getAllowedUpdateFiles(config).has(safeFileName)) {
    throw clientVersionError('客户端更新文件不在允许列表中。', 'INVALID_UPDATE_FILE', 404);
  }

  const updateDir = path.resolve(config.windows.updateDir);
  const filePath = ensureInside(path.join(updateDir, safeFileName), updateDir);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw clientVersionError('客户端更新文件不存在。', 'UPDATE_FILE_NOT_FOUND', 404);
    }
    return { filePath, fileName: safeFileName };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw clientVersionError('客户端更新文件不存在。', 'UPDATE_FILE_NOT_FOUND', 404);
    }
    throw error;
  }
}

module.exports = {
  readClientVersionConfig,
  compareVersion,
  buildPublicVersionStatus,
  getClientVersionStatus,
  getClientUpdateFile
};
