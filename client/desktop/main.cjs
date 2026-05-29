const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  getHealth,
  getClaudeConfig,
  getJiraConfig,
  getKnowledgeBaseStatus,
  getClientVersionStatus,
  getClientRuntimeStatus,
  sendChat,
  sendChatStream,
  listServerConversations,
  getServerConversation,
  createServerConversation,
  renameServerConversation,
  getClaudeCodeOperation,
  confirmClaudeCodeOperation,
  rejectClaudeCodeOperation,
  reportClaudeCodeApplicationResult,
  uploadAttachment,
  rememberAttachment,
  getBugAnalysisRun,
  resumeBugAnalysisRun,
  confirmBugAnalysisComment,
  applyBugAnalysisRecovery
} = require('./baize-api.cjs');
const { createConversationStore } = require('./conversation-store.cjs');
const { createWorkspaceStore } = require('./workspace-store.cjs');
const { createLocalSyncStore } = require('./local-sync-store.cjs');
const { createJiraConfigStore } = require('./jira-config-store.cjs');
const { createLocalJiraService } = require('./local-jira-service.cjs');
const { createLocalRuntime } = require('./local-runtime.cjs');
const { previewPatch, applyPatch } = require('./patch-apply.cjs');

let mainWindow;
let syncTimer = null;
const activeChatStreams = new Map();
const activeAttachmentUploads = new Map();
const updateState = {
  status: 'idle',
  message: '尚未检查更新。',
  versionStatus: null,
  progress: null,
  error: null
};

function getUpdateLogPath() {
  return path.join(app.getPath('userData'), 'update.log');
}

function writeUpdateLog(event, details = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    event,
    appVersion: app.getVersion(),
    ...details
  });
  fs.mkdir(path.dirname(getUpdateLogPath()), { recursive: true })
    .then(() => fs.appendFile(getUpdateLogPath(), `${line}\n`, 'utf8'))
    .catch(() => {});
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(getSettingsPath(), 'utf8'));
  } catch (error) {
    return {};
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

async function getServerUrl() {
  const settings = await readSettings();
  return settings.serverUrl || DEFAULT_SERVER_URL;
}

async function setServerUrl(serverUrl) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const settings = await readSettings();
  await writeSettings({ ...settings, serverUrl: normalizedServerUrl });
  return normalizedServerUrl;
}

async function getClientId() {
  const settings = await readSettings();
  if (settings.clientId) {
    return settings.clientId;
  }

  const clientId = `desktop-${crypto.randomUUID()}`;
  await writeSettings({ ...settings, clientId });
  return clientId;
}

async function getShowServerActivity() {
  const settings = await readSettings();
  return settings.showServerActivity !== false;
}

async function setShowServerActivity(value) {
  const next = value !== false;
  const settings = await readSettings();
  await writeSettings({ ...settings, showServerActivity: next });
  return next;
}

function getConversationStore() {
  return createConversationStore(app.getPath('userData'));
}

function getWorkspaceStore() {
  return createWorkspaceStore(app.getPath('userData'));
}

function getLocalSyncStore() {
  return createLocalSyncStore(app.getPath('userData'));
}

function getJiraConfigStore() {
  return createJiraConfigStore({
    userDataPath: app.getPath('userData'),
    safeStorage,
    getPublicConfig: () => withServerUrl((serverUrl) => getJiraConfig(serverUrl)),
    getRuntimeConfig: () => withServerUrl(async (serverUrl) => getClientRuntimeStatus(serverUrl, { clientId: await getClientId(), platform: 'windows' }))
  });
}

function getLocalJiraService() {
  return createLocalJiraService({
    userDataPath: app.getPath('userData'),
    configStore: getJiraConfigStore(),
    fetchImpl: fetch
  });
}

function getClaudeCodeSessionStore() {
  const filePath = path.join(app.getPath('userData'), 'claude-code-sessions.json');

  async function readSessions() {
    try {
      const sessions = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
    } catch (error) {
      return {};
    }
  }

  return {
    async get(conversationId) {
      const sessions = await readSessions();
      return typeof sessions[conversationId] === 'string' ? sessions[conversationId] : '';
    },
    async set(conversationId, sessionId) {
      const sessions = await readSessions();
      sessions[conversationId] = sessionId;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(sessions, null, 2), 'utf8');
    }
  };
}

function getLocalRuntime() {
  return createLocalRuntime({
    getServerUrl,
    getClientId,
    claudeCodeSessionStore: getClaudeCodeSessionStore(),
    syncStore: getLocalSyncStore(),
    jiraService: getLocalJiraService()
  });
}

async function withServerUrl(handler) {
  const serverUrl = await getServerUrl();
  return handler(serverUrl);
}

async function syncServerEventsOnce() {
  const runtime = getLocalRuntime();
  const result = await runtime.pullSyncEvents({ limit: 100 });
  writeUpdateLog('sync-events-pulled', {
    lastVersion: result && result.lastVersion,
    count: Array.isArray(result && result.events) ? result.events.length : 0
  });
  return result;
}

function startSyncPolling() {
  if (syncTimer) {
    return;
  }
  syncServerEventsOnce().catch((error) => {
    writeUpdateLog('sync-events-pull-failed', { error: error && error.message ? error.message : String(error) });
  });
  syncTimer = setInterval(() => {
    syncServerEventsOnce().catch((error) => {
      writeUpdateLog('sync-events-pull-failed', { error: error && error.message ? error.message : String(error) });
    });
  }, 30000);
}

function stopSyncPolling() {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
  syncTimer = null;
}

function sendUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateState);
  }
}

function setUpdateState(patch) {
  Object.assign(updateState, patch);
  writeUpdateLog('update-state', {
    status: updateState.status,
    message: updateState.message,
    progress: updateState.progress,
    error: updateState.error,
    versionStatus: updateState.versionStatus
  });
  sendUpdateState();
  return updateState;
}

async function checkForClientUpdate({ autoDownload = false } = {}) {
  const serverUrl = await getServerUrl();
  writeUpdateLog('check-start', { serverUrl, autoDownload });
  const versionStatus = await getClientVersionStatus(serverUrl, {
    platform: 'windows',
    version: app.getVersion()
  });
  writeUpdateLog('check-result', { versionStatus });
  const status = versionStatus.updateAvailable ? 'available' : 'not_available';
  setUpdateState({
    status,
    versionStatus,
    progress: null,
    error: null,
    message: versionStatus.updateAvailable ? `发现新版本 ${versionStatus.currentVersion}。` : '当前已经是最新版本。'
  });

  if (versionStatus.updateAvailable && versionStatus.updateUrl) {
    const shouldAutoDownload = autoDownload || versionStatus.updateRequired === true || versionStatus.forceUpdate === true;
    autoUpdater.autoDownload = shouldAutoDownload;
    autoUpdater.setFeedURL({ provider: 'generic', url: versionStatus.updateUrl });
    writeUpdateLog('feed-url-set', { updateUrl: versionStatus.updateUrl, autoDownload: shouldAutoDownload });
    if (shouldAutoDownload) {
      setUpdateState({ status: 'downloading', progress: 0, message: '正在下载更新 0%。' });
      await autoUpdater.checkForUpdates();
    }
  }
  return updateState;
}

function registerAutoUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    writeUpdateLog('auto-updater-checking');
    setUpdateState({ status: 'checking', message: '正在检查客户端更新。' });
  });
  autoUpdater.on('update-available', (info) => {
    writeUpdateLog('auto-updater-available', { info });
    setUpdateState({ status: 'available', message: '发现新版本，可以开始下载。' });
  });
  autoUpdater.on('update-not-available', (info) => {
    writeUpdateLog('auto-updater-not-available', { info });
    setUpdateState({ status: 'not_available', message: '当前已经是最新版本。' });
  });
  autoUpdater.on('download-progress', (progress) => {
    writeUpdateLog('auto-updater-download-progress', { progress });
    setUpdateState({
      status: 'downloading',
      progress: Math.round(progress.percent || 0),
      message: `正在下载更新 ${Math.round(progress.percent || 0)}%。`
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    writeUpdateLog('auto-updater-downloaded', { info });
    setUpdateState({ status: 'downloaded', progress: 100, message: '更新已下载，重启后安装。' });
  });
  autoUpdater.on('error', (error) => {
    const message = error && error.message ? error.message : '更新失败。';
    writeUpdateLog('auto-updater-error', { message, stack: error && error.stack });
    setUpdateState({
      status: 'error',
      error: message,
      message: `客户端更新失败：${message}`
    });
  });
}

async function downloadClientUpdate() {
  writeUpdateLog('download-requested');
  const state = await checkForClientUpdate();
  if (!state.versionStatus || !state.versionStatus.updateAvailable) {
    writeUpdateLog('download-skipped-no-update', { state });
    return state;
  }

  try {
    setUpdateState({ status: 'checking', progress: null, error: null, message: '正在确认客户端更新。' });
    autoUpdater.autoDownload = false;
    writeUpdateLog('download-check-for-updates-start');
    await autoUpdater.checkForUpdates();
    writeUpdateLog('download-update-start');
    setUpdateState({ status: 'downloading', progress: 0, error: null, message: '正在下载更新 0%。' });
    await autoUpdater.downloadUpdate();
    writeUpdateLog('download-update-finished');
    return updateState;
  } catch (error) {
    const message = error && error.message ? error.message : '更新失败。';
    writeUpdateLog('download-error', { message, stack: error && error.stack });
    setUpdateState({
      status: 'error',
      error: message,
      message: `客户端更新失败：${message}`
    });
    throw error;
  }
}

async function withCancellableAttachmentUpload(requestId, handler) {
  const controller = new AbortController();
  if (requestId) {
    activeAttachmentUploads.set(requestId, controller);
  }
  try {
    return await handler(controller.signal);
  } finally {
    if (requestId) {
      activeAttachmentUploads.delete(requestId);
    }
  }
}

function isImageMimeType(mimeType = '') {
  return /^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/i.test(String(mimeType || ''));
}

function isImageFileName(fileName = '') {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(String(fileName || ''));
}

async function writeClipboardImageTempFile(input = {}) {
  const fileName = String(input.fileName || 'clipboard-image.png').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'clipboard-image.png';
  const tempDir = path.join(app.getPath('userData'), 'pending-attachments');
  const tempPath = path.join(tempDir, `${Date.now()}-${crypto.randomUUID()}-${fileName}`);
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(tempPath, Buffer.from(String(input.contentBase64 || ''), 'base64'));
  return tempPath;
}

async function buildAttachmentPayload(input = {}) {
  return {
    fileName: input.fileName || 'clipboard-image.png',
    mimeType: input.mimeType || '',
    contentBase64: input.contentBase64,
    conversationId: input.conversationId,
    clientId: input.clientId || await getClientId(),
    userId: input.userId || 'desktop-user'
  };
}

async function buildAttachmentUploadInput(filePath, input = {}) {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error('只能上传文件。');
  }
  const buffer = await fs.readFile(resolvedPath);
  const fileName = path.basename(resolvedPath);
  const mimeType = input.mimeType || '';
  return buildAttachmentPayload({
    ...input,
    fileName,
    mimeType,
    contentBase64: buffer.toString('base64')
  });
}

async function uploadClipboardAttachment(input = {}, signal) {
  const fileName = input.fileName || 'clipboard-image.png';
  const mimeType = input.mimeType || '';
  let localPath = '';
  if (input.contentBase64 && (isImageMimeType(mimeType) || isImageFileName(fileName))) {
    localPath = await writeClipboardImageTempFile(input);
  }
  const payload = await buildAttachmentPayload(input);
  const result = await withServerUrl(async (serverUrl) => uploadAttachment(serverUrl, payload, { signal }));
  const attachment = result && result.attachment ? result.attachment : result;
  return result && result.attachment
    ? { ...result, attachment: { ...attachment, localPath: localPath || undefined } }
    : { ...attachment, localPath: localPath || undefined };
}

function registerIpcHandlers() {
  ipcMain.handle('settings:getServerUrl', () => getServerUrl());
  ipcMain.handle('settings:setServerUrl', (event, serverUrl) => setServerUrl(serverUrl));
  ipcMain.handle('settings:getClientId', () => getClientId());
  ipcMain.handle('settings:getShowServerActivity', () => getShowServerActivity());
  ipcMain.handle('settings:setShowServerActivity', (event, value) => setShowServerActivity(value));
  ipcMain.handle('debug:log', async (event, line) => {
    try {
      const logPath = path.join(app.getPath('userData'), 'baize-renderer.log');
      await fs.appendFile(logPath, `${new Date().toISOString()} ${typeof line === 'string' ? line : JSON.stringify(line)}\n`, 'utf8');
      return logPath;
    } catch (error) {
      return null;
    }
  });
  ipcMain.handle('update:getStatus', () => updateState);
  ipcMain.handle('update:check', () => checkForClientUpdate());
  ipcMain.handle('update:download', () => downloadClientUpdate());
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
    return true;
  });
  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });
  ipcMain.handle('window:toggleMaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });
  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });
  ipcMain.handle('baize:health', () => withServerUrl((serverUrl) => getHealth(serverUrl)));
  ipcMain.handle('baize:claudeConfig', () => withServerUrl((serverUrl) => getClaudeConfig(serverUrl)));
  ipcMain.handle('baize:knowledgeBaseStatus', () => withServerUrl((serverUrl) => getKnowledgeBaseStatus(serverUrl)));
  ipcMain.handle('baize:syncNow', () => syncServerEventsOnce());
  ipcMain.handle('baize:controlPlaneStatus', () => getLocalRuntime().getControlPlaneStatus());
  ipcMain.handle('baize:chat', async (event, input) => getLocalRuntime().handleChat(input));
  ipcMain.handle('baize:chatStream', async (event, { requestId, input } = {}) => {
    const controller = new AbortController();
    if (requestId) {
      activeChatStreams.set(requestId, controller);
    }
    try {
      return await getLocalRuntime().handleChatStream(input, {
        signal: controller.signal,
        onEvent: (streamEvent) => {
          event.sender.send('baize:chatStream:event', { requestId, event: streamEvent });
        }
      });
    } finally {
      if (requestId) {
        activeChatStreams.delete(requestId);
      }
    }
  });
  ipcMain.handle('baize:chatStream:cancel', (event, requestId) => {
    const chatController = activeChatStreams.get(requestId);
    const uploadController = activeAttachmentUploads.get(requestId);
    if (chatController) {
      chatController.abort();
      activeChatStreams.delete(requestId);
    }
    if (uploadController) {
      uploadController.abort();
      activeAttachmentUploads.delete(requestId);
    }
    return Boolean(chatController || uploadController);
  });
  ipcMain.handle('conversation:list', () => getConversationStore().listConversations());
  ipcMain.handle('conversation:create', (event, input) => getConversationStore().createConversation(input));
  ipcMain.handle('conversation:get', (event, conversationId) => getConversationStore().getConversation(conversationId));
  ipcMain.handle('conversation:update', (event, conversationId, patch) => getConversationStore().updateConversation(conversationId, patch));
  ipcMain.handle('conversation:delete', (event, conversationId) => getConversationStore().deleteConversation(conversationId));
  ipcMain.handle('conversation:appendMessage', (event, conversationId, message) => getConversationStore().appendMessage(conversationId, message));
  ipcMain.handle('serverConversations:list', async () => withServerUrl(async (serverUrl) => listServerConversations(serverUrl, { clientId: await getClientId() })));
  ipcMain.handle('serverConversations:get', (event, conversationId) => withServerUrl((serverUrl) => getServerConversation(serverUrl, conversationId)));
  ipcMain.handle('serverConversations:create', async (event, input) => withServerUrl(async (serverUrl) => createServerConversation(serverUrl, {
    ...input,
    clientId: await getClientId()
  })));
  ipcMain.handle('serverConversations:rename', (event, conversationId, input) => withServerUrl((serverUrl) => renameServerConversation(serverUrl, conversationId, input)));
  ipcMain.handle('claudeCode:getOperation', (event, operationId) => withServerUrl((serverUrl) => getClaudeCodeOperation(serverUrl, operationId)));
  ipcMain.handle('claudeCode:confirmOperation', async (event, operationId, input = {}) => withServerUrl(async (serverUrl) => confirmClaudeCodeOperation(serverUrl, operationId, {
    ...input,
    clientId: input.clientId || await getClientId()
  })));
  ipcMain.handle('claudeCode:rejectOperation', async (event, operationId, input = {}) => withServerUrl(async (serverUrl) => rejectClaudeCodeOperation(serverUrl, operationId, {
    ...input,
    clientId: input.clientId || await getClientId()
  })));
  ipcMain.handle('claudeCode:reportApplicationResult', async (event, operationId, input = {}) => withServerUrl(async (serverUrl) => reportClaudeCodeApplicationResult(serverUrl, operationId, {
    ...input,
    clientId: input.clientId || await getClientId()
  })));
  ipcMain.handle('attachment:uploadFile', async (event, filePath, input = {}) => withCancellableAttachmentUpload(input.requestId, (signal) => withServerUrl(async (serverUrl) => uploadAttachment(serverUrl, await buildAttachmentUploadInput(filePath, input, { signal }), { signal }))));
  ipcMain.handle('attachment:uploadData', async (event, input = {}) => withCancellableAttachmentUpload(input.requestId, (signal) => uploadClipboardAttachment(input, signal)));
  ipcMain.handle('attachment:remember', async (event, attachmentId, input = {}) => getLocalRuntime().rememberAttachment(attachmentId, input));
  ipcMain.handle('jira:importDrafts', async (event, input = {}) => getLocalJiraService().createJiraImportDraftsWithOperation({
    ...input,
    clientId: input.clientId || await getClientId()
  }));
  ipcMain.handle('jira:getOperation', (event, operationId) => getLocalJiraService().getJiraOperation(operationId));
  ipcMain.handle('jira:confirmOperation', async (event, operationId, input = {}) => getLocalRuntime().confirmJiraOperation(operationId, {
    ...input,
    clientId: input.clientId || await getClientId()
  }, {
    onEvent: (runtimeEvent) => {
      event.sender.send('jira:confirmOperation:event', { operationId, event: runtimeEvent });
    }
  }));
  ipcMain.handle('jira:updateOperationDrafts', async (event, operationId, input = {}) => getLocalJiraService().updateJiraOperationDrafts(operationId, input, {
    ...input,
    clientId: input.clientId || await getClientId()
  }));
  ipcMain.handle('jira:rejectOperation', async (event, operationId, input = {}) => getLocalJiraService().rejectJiraOperation(operationId, {
    ...input,
    clientId: input.clientId || await getClientId()
  }));
  ipcMain.handle('jira:recoverOperation', async (event, operationId, input = {}) => getLocalJiraService().recoverJiraOperation(operationId, {
    ...input,
    clientId: input.clientId || await getClientId()
  }));
  ipcMain.handle('jiraBugAnalysis:getRun', (event, runId) => withServerUrl((serverUrl) => getBugAnalysisRun(serverUrl, runId)));
  ipcMain.handle('jiraBugAnalysis:resumeRun', async (event, runId, input = {}) => withServerUrl(async (serverUrl) => resumeBugAnalysisRun(serverUrl, runId, {
    ...input,
    clientId: input.clientId || await getClientId()
  })));
  ipcMain.handle('jiraBugAnalysis:confirmComment', async (event, runId, itemId, input = {}) => withServerUrl(async (serverUrl) => confirmBugAnalysisComment(serverUrl, runId, itemId, {
    ...input,
    clientId: input.clientId || await getClientId()
  })));
  ipcMain.handle('jiraBugAnalysis:recoverItem', async (event, runId, itemId, input = {}) => withServerUrl(async (serverUrl) => applyBugAnalysisRecovery(serverUrl, runId, itemId, {
    ...input,
    clientId: input.clientId || await getClientId()
  })));
  ipcMain.handle('audit:confirm', async (event, auditId) => withServerUrl(async (serverUrl) => {
    const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/audit/${encodeURIComponent(auditId)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: await getClientId() })
    });
    return response.json();
  }));
  ipcMain.handle('audit:reject', async (event, auditId) => withServerUrl(async (serverUrl) => {
    const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/audit/${encodeURIComponent(auditId)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: await getClientId() })
    });
    return response.json();
  }));
  ipcMain.handle('workspace:list', () => getWorkspaceStore().listWorkspaces());
  ipcMain.handle('workspace:authorize', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择允许白泽修改的本地工作区'
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return getWorkspaceStore().authorizeWorkspace(result.filePaths[0]);
  });
  ipcMain.handle('workspace:setActive', (event, workspaceId) => getWorkspaceStore().setActiveWorkspace(workspaceId));
  ipcMain.handle('workspace:revoke', (event, workspaceId) => getWorkspaceStore().revokeWorkspace(workspaceId));
  ipcMain.handle('patch:preview', async (event, { workspaceId, patch } = {}) => {
    const workspace = workspaceId ? await getWorkspaceStore().getWorkspace(workspaceId) : await getWorkspaceStore().getActiveWorkspace();
    if (!workspace) {
      throw new Error('请先选择本地工作区。');
    }
    return previewPatch({ workspaceRoot: workspace.rootPath, patch });
  });
  ipcMain.handle('patch:apply', async (event, { workspaceId, patch } = {}) => {
    const workspace = workspaceId ? await getWorkspaceStore().getWorkspace(workspaceId) : await getWorkspaceStore().getActiveWorkspace();
    if (!workspace) {
      throw new Error('请先选择本地工作区。');
    }
    return applyPatch({ workspaceRoot: workspace.rootPath, patch });
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    frame: false,
    title: '白泽',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    backgroundColor: '#f4f4f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  registerAutoUpdaterEvents();
  registerIpcHandlers();
  createWindow();
  startSyncPolling();
  checkForClientUpdate().catch((error) => {
    setUpdateState({
      status: 'error',
      error: error && error.message ? error.message : '检查更新失败。',
      message: '检查客户端更新失败。'
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopSyncPolling();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
