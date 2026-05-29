const DEFAULT_SERVER_URL = process.env.BAIZE_DESKTOP_SERVER_URL || 'http://127.0.0.1:3000';

function normalizeServerUrl(serverUrl = DEFAULT_SERVER_URL) {
  try {
    const url = new URL(serverUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Invalid protocol');
    }

    return url.origin;
  } catch (error) {
    const invalidUrlError = new Error('请输入有效的白泽服务器地址，例如 http://127.0.0.1:3000。');
    invalidUrlError.code = 'INVALID_SERVER_URL';
    throw invalidUrlError;
  }
}

function buildUrl(serverUrl, pathname) {
  return new URL(pathname, `${normalizeServerUrl(serverUrl)}/`).toString();
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const parseError = new Error('白泽服务器返回了无效的 JSON。');
    parseError.code = 'INVALID_SERVER_RESPONSE';
    throw parseError;
  }
}

function translateApiErrorMessage(message, status) {
  if (message === 'Route not found.') {
    return '白泽服务器版本过旧，缺少当前客户端需要的接口。请重启服务器或更新服务器后再试。';
  }

  if (message === 'Internal server error.') {
    return '白泽服务器内部错误，请稍后重试或查看服务器日志。';
  }

  if (message === 'text is required.') {
    return '请输入要发送的内容。';
  }

  if (status === 404) {
    return '白泽服务器没有找到这个接口，请确认服务器已更新并重启。';
  }

  return message || `白泽服务器请求失败：HTTP ${status}`;
}

function throwApiError(payload, response) {
  const rawMessage = payload && payload.error && payload.error.message
    ? payload.error.message
    : null;
  const error = new Error(translateApiErrorMessage(rawMessage, response.status));
  error.code = payload && payload.error && payload.error.code ? payload.error.code : 'BAIZE_API_ERROR';
  error.status = response.status;
  error.data = payload && payload.data ? payload.data : null;
  throw error;
}

async function requestJson(serverUrl, pathname, { method = 'GET', body, fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(buildUrl(serverUrl, pathname), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const cancelError = new Error('已取消本次回答。');
      cancelError.code = 'BAIZE_REQUEST_CANCELLED';
      throw cancelError;
    }
    const connectionError = new Error('无法连接白泽服务器。请确认服务器已启动后重试。');
    connectionError.code = 'BAIZE_SERVER_UNREACHABLE';
    throw connectionError;
  }

  const payload = await readJsonResponse(response);
  if (!response.ok || (payload && payload.ok === false)) {
    throwApiError(payload, response);
  }

  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

function getHealth(serverUrl, options) {
  return requestJson(serverUrl, '/health', options);
}

function getClaudeConfig(serverUrl, options) {
  return requestJson(serverUrl, '/config/claude', options);
}

function getClaudeCodeConfig(serverUrl, options) {
  return requestJson(serverUrl, '/config/claude-code', options);
}

function getJiraConfig(serverUrl, options) {
  return requestJson(serverUrl, '/config/jira', options);
}

function getKnowledgeBaseStatus(serverUrl, options) {
  return requestJson(serverUrl, '/plugins/knowledge-base/status', options);
}

function getClientVersionStatus(serverUrl, { version, platform = 'windows' } = {}, options) {
  const query = `?platform=${encodeURIComponent(platform)}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
  return requestJson(serverUrl, `/client/version${query}`, options);
}

function getClientRuntimeStatus(serverUrl, { clientId, platform = 'windows' } = {}, options) {
  const query = `?platform=${encodeURIComponent(platform)}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`;
  return requestJson(serverUrl, `/client/runtime${query}`, options);
}

function getPluginUpdates(serverUrl, options) {
  return requestJson(serverUrl, '/plugins/updates', options);
}

function searchJiraIssues(serverUrl, input = {}, options) {
  return requestJson(serverUrl, '/plugins/jira/search', {
    ...options,
    method: 'POST',
    body: input
  });
}

function sendChat(serverUrl, { text, userId = 'desktop-user', conversationId, clientId, attachmentIds } = {}, options) {
  return requestJson(serverUrl, '/chat', {
    ...options,
    method: 'POST',
    body: {
      text,
      platform: 'desktop',
      userId,
      conversationId,
      clientId,
      attachmentIds
    }
  });
}

async function sendChatStream(serverUrl, { text, userId = 'desktop-user', conversationId, clientId, attachmentIds } = {}, { fetchImpl = fetch, onEvent, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(buildUrl(serverUrl, '/chat/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        platform: 'desktop',
        userId,
        conversationId,
        clientId,
        attachmentIds
      }),
      signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const cancelError = new Error('已取消本次回答。');
      cancelError.code = 'BAIZE_REQUEST_CANCELLED';
      throw cancelError;
    }
    const connectionError = new Error('无法连接白泽服务器。请确认服务器已启动后重试。');
    connectionError.code = 'BAIZE_SERVER_UNREACHABLE';
    throw connectionError;
  }

  if (!response.ok) {
    if (response.status === 404) {
      const fallbackResult = await sendChat(serverUrl, { text, userId, conversationId, clientId, attachmentIds }, { fetchImpl, signal });
      const fallbackEvent = { type: 'done', ...fallbackResult };
      if (typeof onEvent === 'function') {
        onEvent({ type: 'delta', text: fallbackResult.reply || '' });
        onEvent(fallbackEvent);
      }
      return fallbackEvent;
    }

    const payload = await readJsonResponse(response);
    throwApiError(payload, response);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let result = null;

  function emit(event) {
    if (typeof onEvent === 'function') {
      onEvent(event);
    }
    if (event.type === 'done') {
      result = event;
    }
    if (event.type === 'error') {
      const streamError = new Error(event.message || '白泽流式回复失败。');
      streamError.code = event.code || 'BAIZE_STREAM_ERROR';
      throw streamError;
    }
  }

  function consumeBuffer() {
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith('data:'));
      if (!dataLine) {
        continue;
      }
      emit(JSON.parse(dataLine.slice(5).trim()));
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      consumeBuffer();
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const cancelError = new Error('已取消本次回答。');
      cancelError.code = 'BAIZE_REQUEST_CANCELLED';
      throw cancelError;
    }
    throw error;
  }

  buffer += decoder.decode();
  consumeBuffer();
  return result;
}

function listServerConversations(serverUrl, { clientId } = {}, options) {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return requestJson(serverUrl, `/conversations${query}`, options);
}

function getServerConversation(serverUrl, conversationId, options) {
  return requestJson(serverUrl, `/conversations/${encodeURIComponent(conversationId)}`, options);
}

function createServerConversation(serverUrl, input = {}, options) {
  return requestJson(serverUrl, '/conversations', {
    ...options,
    method: 'POST',
    body: {
      ...input,
      platform: 'desktop'
    }
  });
}

function renameServerConversation(serverUrl, conversationId, { title } = {}, options) {
  return requestJson(serverUrl, `/conversations/${encodeURIComponent(conversationId)}`, {
    ...options,
    method: 'PATCH',
    body: { title }
  });
}

function getClaudeCodeOperation(serverUrl, operationId, options) {
  return requestJson(serverUrl, `/claude-code/operations/${encodeURIComponent(operationId)}`, options);
}

function confirmClaudeCodeOperation(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/claude-code/operations/${encodeURIComponent(operationId)}/confirm`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function rejectClaudeCodeOperation(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/claude-code/operations/${encodeURIComponent(operationId)}/reject`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function reportClaudeCodeApplicationResult(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/claude-code/operations/${encodeURIComponent(operationId)}/application-result`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function uploadAttachment(serverUrl, input = {}, options) {
  return requestJson(serverUrl, '/attachments/upload', {
    ...options,
    method: 'POST',
    body: input
  });
}

function sanitizeClientAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const body = {};
  for (const key of ['provider', 'summary', 'memoryCategory', 'shouldRemember', 'reason', 'extractedText']) {
    if (['provider', 'summary', 'memoryCategory', 'reason', 'extractedText'].includes(key) && typeof value[key] === 'string') {
      body[key] = value[key];
    } else if (key === 'shouldRemember' && typeof value[key] === 'boolean') {
      body[key] = value[key];
    }
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

function rememberAttachment(serverUrl, attachmentId, input = {}, options) {
  const body = {};
  if (typeof input.category === 'string' && input.category.trim() !== '') {
    body.category = input.category.trim();
  }
  const clientAnalysis = sanitizeClientAnalysis(input.clientAnalysis);
  if (clientAnalysis) {
    body.clientAnalysis = clientAnalysis;
  }
  return requestJson(serverUrl, `/attachments/${encodeURIComponent(attachmentId)}/remember`, {
    ...options,
    method: 'POST',
    body
  });
}

function createJiraImportDrafts(serverUrl, input = {}, options) {
  return requestJson(serverUrl, '/plugins/jira/import-drafts', {
    ...options,
    method: 'POST',
    body: input
  });
}

function getJiraOperation(serverUrl, operationId, options) {
  return requestJson(serverUrl, `/plugins/jira/operations/${encodeURIComponent(operationId)}`, options);
}

function confirmJiraOperation(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/operations/${encodeURIComponent(operationId)}/confirm`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function updateJiraOperationDrafts(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/operations/${encodeURIComponent(operationId)}/drafts`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function rejectJiraOperation(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/operations/${encodeURIComponent(operationId)}/reject`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function recoverJiraOperation(serverUrl, operationId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/operations/${encodeURIComponent(operationId)}/recovery`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function appendSyncEvent(serverUrl, input = {}, options) {
  return requestJson(serverUrl, '/sync/events', {
    ...options,
    method: 'POST',
    body: input
  });
}

function listSyncEvents(serverUrl, { since = 0, limit } = {}, options) {
  const query = `?since=${encodeURIComponent(since)}${limit ? `&limit=${encodeURIComponent(limit)}` : ''}`;
  return requestJson(serverUrl, `/sync/events${query}`, options);
}

function getBugAnalysisRun(serverUrl, runId, options) {
  return requestJson(serverUrl, `/plugins/jira/bug-analysis/runs/${encodeURIComponent(runId)}`, options);
}

function resumeBugAnalysisRun(serverUrl, runId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/bug-analysis/runs/${encodeURIComponent(runId)}/resume`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function confirmBugAnalysisComment(serverUrl, runId, itemId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/bug-analysis/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/comment/confirm`, {
    ...options,
    method: 'POST',
    body: input
  });
}

function applyBugAnalysisRecovery(serverUrl, runId, itemId, input = {}, options) {
  return requestJson(serverUrl, `/plugins/jira/bug-analysis/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/recovery`, {
    ...options,
    method: 'POST',
    body: input
  });
}

module.exports = {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  getHealth,
  getClaudeConfig,
  getClaudeCodeConfig,
  getJiraConfig,
  getKnowledgeBaseStatus,
  getClientVersionStatus,
  getClientRuntimeStatus,
  getPluginUpdates,
  searchJiraIssues,
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
  createJiraImportDrafts,
  getJiraOperation,
  confirmJiraOperation,
  updateJiraOperationDrafts,
  rejectJiraOperation,
  recoverJiraOperation,
  appendSyncEvent,
  listSyncEvents,
  getBugAnalysisRun,
  resumeBugAnalysisRun,
  confirmBugAnalysisComment,
  applyBugAnalysisRecovery
};
