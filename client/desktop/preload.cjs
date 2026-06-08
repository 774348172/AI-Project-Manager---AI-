const { contextBridge, ipcRenderer, webUtils } = require('electron');

let activeChatStreamRequestId = null;

function beginCancellableRequest() {
  activeChatStreamRequestId = `${Date.now()}-${Math.random()}`;
  return activeChatStreamRequestId;
}

function chatStream(input, onEvent, requestId = beginCancellableRequest()) {
  activeChatStreamRequestId = requestId;
  const listener = (event, payload) => {
    if (payload && payload.requestId === requestId && typeof onEvent === 'function') {
      onEvent(payload.event);
    }
  };

  ipcRenderer.on('baize:chatStream:event', listener);
  return ipcRenderer.invoke('baize:chatStream', { requestId, input })
    .finally(() => {
      if (activeChatStreamRequestId === requestId) {
        activeChatStreamRequestId = null;
      }
      ipcRenderer.removeListener('baize:chatStream:event', listener);
    });
}

function cancelChatStream() {
  if (!activeChatStreamRequestId) {
    return Promise.resolve(false);
  }
  return ipcRenderer.invoke('baize:chatStream:cancel', activeChatStreamRequestId);
}

function confirmJiraOperation(operationId, input, onEvent) {
  const listener = (event, payload) => {
    if (payload && payload.operationId === operationId && typeof onEvent === 'function') {
      onEvent(payload.event);
    }
  };
  ipcRenderer.on('jira:confirmOperation:event', listener);
  return ipcRenderer.invoke('jira:confirmOperation', operationId, input)
    .finally(() => {
      ipcRenderer.removeListener('jira:confirmOperation:event', listener);
    });
}

function confirmAutoFixBugQueue(queue, input, onEvent) {
  const queueId = queue && queue.id;
  const listener = (event, payload) => {
    if (payload && payload.queueId === queueId && typeof onEvent === 'function') {
      onEvent(payload.event);
    }
  };
  ipcRenderer.on('jira:autoFixBugQueue:event', listener);
  return ipcRenderer.invoke('jira:autoFixBugQueue:confirm', queue, input)
    .finally(() => {
      ipcRenderer.removeListener('jira:autoFixBugQueue:event', listener);
    });
}

function confirmRequirementCompletionRun(run, input, onEvent) {
  const runId = run && run.id;
  const listener = (event, payload) => {
    if (payload && payload.runId === runId && typeof onEvent === 'function') {
      onEvent(payload.event);
    }
  };
  ipcRenderer.on('requirementCompletion:confirm:event', listener);
  return ipcRenderer.invoke('requirementCompletion:confirm', run, input)
    .finally(() => {
      ipcRenderer.removeListener('requirementCompletion:confirm:event', listener);
    });
}

contextBridge.exposeInMainWorld('baize', {
  getServerUrl: () => ipcRenderer.invoke('settings:getServerUrl'),
  setServerUrl: (serverUrl) => ipcRenderer.invoke('settings:setServerUrl', serverUrl),
  getClientId: () => ipcRenderer.invoke('settings:getClientId'),
  getMachineCode: () => ipcRenderer.invoke('settings:getMachineCode'),
  getAuth: () => ipcRenderer.invoke('auth:current'),
  login: (input) => ipcRenderer.invoke('auth:login', input),
  register: (input) => ipcRenderer.invoke('auth:register', input),
  saveAccountJiraDefaults: (input) => ipcRenderer.invoke('auth:saveJiraDefaults', input),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getClientAccount: () => ipcRenderer.invoke('account:get'),
  saveClientProfile: (input) => ipcRenderer.invoke('account:saveProfile', input),
  saveSvnBinding: (input) => ipcRenderer.invoke('account:saveSvnBinding', input),
  saveJiraBinding: (input) => ipcRenderer.invoke('account:saveJiraBinding', input),
  saveWeComBinding: (input) => ipcRenderer.invoke('account:saveWeComBinding', input),
  getShowServerActivity: () => ipcRenderer.invoke('settings:getShowServerActivity'),
  setShowServerActivity: (value) => ipcRenderer.invoke('settings:setShowServerActivity', value),
  debugLog: (line) => ipcRenderer.invoke('debug:log', line),
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onUpdateState: (listener) => {
    const wrapped = (event, state) => {
      if (typeof listener === 'function') {
        listener(state);
      }
    };
    ipcRenderer.on('update:state', wrapped);
    return () => ipcRenderer.removeListener('update:state', wrapped);
  },
  health: () => ipcRenderer.invoke('baize:health'),
  getClaudeConfig: () => ipcRenderer.invoke('baize:claudeConfig'),
  getKnowledgeBaseStatus: () => ipcRenderer.invoke('baize:knowledgeBaseStatus'),
  getUnityBuildStatus: () => ipcRenderer.invoke('unityBuild:getStatus'),
  setUnityBuildScheduler: (input) => ipcRenderer.invoke('unityBuild:setScheduler', input),
  runUnityBuildOnce: (input) => ipcRenderer.invoke('unityBuild:runOnce', input),
  chat: (input) => ipcRenderer.invoke('baize:chat', input),
  beginCancellableRequest,
  chatStream,
  cancelChatStream,
  listConversations: () => ipcRenderer.invoke('conversation:list'),
  createConversation: (input) => ipcRenderer.invoke('conversation:create', input),
  getConversation: (conversationId) => ipcRenderer.invoke('conversation:get', conversationId),
  updateConversation: (conversationId, patch) => ipcRenderer.invoke('conversation:update', conversationId, patch),
  deleteConversation: (conversationId) => ipcRenderer.invoke('conversation:delete', conversationId),
  appendConversationMessage: (conversationId, message) => ipcRenderer.invoke('conversation:appendMessage', conversationId, message),
  listServerConversations: () => ipcRenderer.invoke('serverConversations:list'),
  getServerConversation: (conversationId) => ipcRenderer.invoke('serverConversations:get', conversationId),
  createServerConversation: (input) => ipcRenderer.invoke('serverConversations:create', input),
  renameServerConversation: (conversationId, input) => ipcRenderer.invoke('serverConversations:rename', conversationId, input),
  getClaudeCodeOperation: (operationId) => ipcRenderer.invoke('claudeCode:getOperation', operationId),
  confirmClaudeCodeOperation: (operationId, input) => ipcRenderer.invoke('claudeCode:confirmOperation', operationId, input),
  rejectClaudeCodeOperation: (operationId, input) => ipcRenderer.invoke('claudeCode:rejectOperation', operationId, input),
  reportClaudeCodeApplicationResult: (operationId, input) => ipcRenderer.invoke('claudeCode:reportApplicationResult', operationId, input),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  uploadAttachmentFile: (filePath, input) => ipcRenderer.invoke('attachment:uploadFile', filePath, input),
  uploadAttachmentData: (input) => ipcRenderer.invoke('attachment:uploadData', input),
  rememberAttachment: (attachmentId, input) => ipcRenderer.invoke('attachment:remember', attachmentId, input),
  createJiraImportDrafts: (input) => ipcRenderer.invoke('jira:importDrafts', input),
  getJiraOperation: (operationId) => ipcRenderer.invoke('jira:getOperation', operationId),
  confirmJiraOperation,
  confirmAutoFixBugQueue,
  confirmRequirementCompletionRun,
  getRequirementCompletionRun: (runId) => ipcRenderer.invoke('requirementCompletion:getRun', runId),
  recoverRequirementCompletionRun: (runId, input) => ipcRenderer.invoke('requirementCompletion:recover', runId, input),
  updateJiraOperationDrafts: (operationId, input) => ipcRenderer.invoke('jira:updateOperationDrafts', operationId, input),
  rejectJiraOperation: (operationId, input) => ipcRenderer.invoke('jira:rejectOperation', operationId, input),
  recoverJiraOperation: (operationId, input) => ipcRenderer.invoke('jira:recoverOperation', operationId, input),
  getBugAnalysisRun: (runId) => ipcRenderer.invoke('jiraBugAnalysis:getRun', runId),
  resumeBugAnalysisRun: (runId, input) => ipcRenderer.invoke('jiraBugAnalysis:resumeRun', runId, input),
  confirmBugAnalysisComment: (runId, itemId, input) => ipcRenderer.invoke('jiraBugAnalysis:confirmComment', runId, itemId, input),
  applyBugAnalysisRecovery: (runId, itemId, input) => ipcRenderer.invoke('jiraBugAnalysis:recoverItem', runId, itemId, input),
  confirmPluginAudit: (auditId) => ipcRenderer.invoke('audit:confirm', auditId),
  rejectPluginAudit: (auditId) => ipcRenderer.invoke('audit:reject', auditId),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  authorizeWorkspace: () => ipcRenderer.invoke('workspace:authorize'),
  setActiveWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:setActive', workspaceId),
  revokeWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:revoke', workspaceId),
  previewPatch: (input) => ipcRenderer.invoke('patch:preview', input),
  applyPatch: (input) => ipcRenderer.invoke('patch:apply', input)
});
