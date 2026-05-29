const { sendChat, sendChatStream, getClaudeCodeConfig, getClientRuntimeStatus, getPluginUpdates, searchJiraIssues, appendSyncEvent, listSyncEvents, rememberAttachment: rememberServerAttachment } = require('./baize-api.cjs');
const { createLocalClaudeCodeChat, isAllowedLocalSyncEventType, analyzeLocalImageAttachment } = require('./local-claude-code.cjs');

function stripLocalOnlyChatInput(input = {}) {
  const {
    localAttachments,
    attachments,
    localPath,
    filePath,
    ...serverInput
  } = input;
  return serverInput;
}

function createLocalRuntime({ getServerUrl, getClientId, chatTransport = {}, getRuntimeConfig, localClaudeCode, imageAnalyzer = analyzeLocalImageAttachment, claudeCodeSessionStore, syncStore, jiraService } = {}) {
  if (typeof getServerUrl !== 'function') {
    throw new Error('getServerUrl is required.');
  }
  if (typeof getClientId !== 'function') {
    throw new Error('getClientId is required.');
  }

  const transport = {
    sendChat: chatTransport.sendChat || sendChat,
    sendChatStream: chatTransport.sendChatStream || sendChatStream,
    getClaudeCodeConfig: chatTransport.getClaudeCodeConfig || getClaudeCodeConfig,
    getClientRuntimeStatus: chatTransport.getClientRuntimeStatus || getClientRuntimeStatus,
    getPluginUpdates: chatTransport.getPluginUpdates || getPluginUpdates,
    searchJiraIssues: chatTransport.searchJiraIssues || searchJiraIssues,
    appendSyncEvent: chatTransport.appendSyncEvent || appendSyncEvent,
    listSyncEvents: chatTransport.listSyncEvents || listSyncEvents,
    rememberAttachment: chatTransport.rememberAttachment || rememberServerAttachment
  };
  const localChat = localClaudeCode || createLocalClaudeCodeChat({ sessionStore: claudeCodeSessionStore });

  async function buildChatInput(input = {}, serverUrl) {
    const chatInput = {
      ...input,
      clientId: input.clientId || await getClientId()
    };
    if (!chatInput.pluginPermissions && serverUrl) {
      try {
        const plugins = await transport.getPluginUpdates(serverUrl);
        chatInput.pluginPermissions = plugins;
      } catch (error) {
        chatInput.pluginPermissions = { enabled: false, plugins: [] };
      }
    }
    return chatInput;
  }

  async function readRuntimeConfig(serverUrl) {
    if (typeof getRuntimeConfig === 'function') {
      return getRuntimeConfig(serverUrl);
    }
    try {
      return await transport.getClientRuntimeStatus(serverUrl, { clientId: await getClientId(), platform: 'windows' });
    } catch (error) {
      try {
        return await transport.getClaudeCodeConfig(serverUrl);
      } catch (nestedError) {
        return { enabled: false, unavailable: true };
      }
    }
  }

  function shouldUseLocalClaudeCode(config) {
    if (!config) {
      return false;
    }
    if (config.localClaudeCode && typeof config.localClaudeCode === 'object') {
      return config.enabled !== false && config.localClaudeCode.enabled === true;
    }
    return config.enabled === true;
  }

  function readStringMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => typeof key === 'string' && key.trim() !== '' && typeof item === 'string' && item.trim() !== '')
      .map(([key, item]) => [key.trim(), item.trim()]));
  }

  function sanitizeClientAnalysis(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const analysis = {};
    for (const key of ['provider', 'summary', 'memoryCategory', 'reason', 'extractedText']) {
      if (typeof value[key] === 'string') {
        analysis[key] = value[key];
      }
    }
    if (typeof value.shouldRemember === 'boolean') {
      analysis.shouldRemember = value.shouldRemember;
    }
    return analysis;
  }

  function getLocalClaudeCodeEnv(config) {
    return readStringMap(config && config.localClaudeCode && config.localClaudeCode.env);
  }

  function emitStatus(onEvent, message, extra = {}) {
    if (typeof onEvent === 'function') {
      onEvent({ type: 'status', message, ...extra });
    }
  }

  function describeJiraToolStart(action, input = {}) {
    if (action === 'get_project') {
      return `正在校验 Jira 项目${input.projectKey ? ` ${input.projectKey}` : ''}。`;
    }
    if (action === 'get_create_meta') {
      return `正在读取 Jira 创建字段${input.projectKey ? `（${input.projectKey}）` : ''}。`;
    }
    if (action === 'search_user') {
      const query = input.query || input.assignee || input.name || input.email || '';
      return `正在查询 Jira 用户${query ? ` ${query}` : ''}。`;
    }
    if (action === 'create_confirmed_issue') {
      const index = Number.isInteger(input.draftIndex) ? `第 ${input.draftIndex + 1} 个` : '已确认的';
      const summary = input.draft && input.draft.summary ? `：${input.draft.summary}` : '';
      return `正在创建${index} Jira 单${summary}。`;
    }
    return `正在执行 Jira 工具：${action}`;
  }

  function describeJiraToolDone(action, result = {}) {
    if (action === 'get_project') {
      return `已确认 Jira 项目${result.key ? ` ${result.key}` : ''}。`;
    }
    if (action === 'get_create_meta') {
      return '已读取 Jira 创建字段，正在交给 Claude Code 判断字段格式。';
    }
    if (action === 'search_user') {
      return '已完成 Jira 用户查询，正在交给 Claude Code 判断负责人字段。';
    }
    if (action === 'create_confirmed_issue') {
      const key = result.createdIssue && result.createdIssue.key;
      return key ? `已创建 Jira 单 ${key}。` : 'Jira 创建请求已完成，正在刷新创建状态。';
    }
    return `Jira 工具 ${action} 执行完成。`;
  }

  function redactRuntimeConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return config;
    }
    const next = { ...config };
    if (config.localClaudeCode && typeof config.localClaudeCode === 'object' && !Array.isArray(config.localClaudeCode)) {
      const env = readStringMap(config.localClaudeCode.env);
      const { env: omittedEnv, ...localClaudeCode } = config.localClaudeCode;
      next.localClaudeCode = {
        ...localClaudeCode,
        envConfigured: Object.keys(env).length > 0
      };
    }
    if (config.jira && typeof config.jira === 'object' && !Array.isArray(config.jira)) {
      const { password, apiToken, ...jira } = config.jira;
      next.jira = {
        ...jira,
        credentialConfigured: Boolean(password || apiToken || jira.username || jira.email)
      };
    }
    return next;
  }

  async function executeClientOperation(serverUrl, chatInput, operation = {}, { signal, onEvent, confirmedJiraOperationId } = {}) {
    const allowedActions = ['search_issue', 'create_issue', 'get_project', 'get_create_meta', 'search_user', 'create_confirmed_issue'];
    if (operation.plugin !== 'jira' || !allowedActions.includes(operation.action)) {
      return { ok: false, code: 'CLIENT_PLUGIN_ACTION_UNSUPPORTED', message: '当前客户端不支持这个 Jira 插件桥操作。' };
    }
    try {
      const input = operation.input && typeof operation.input === 'object' && !Array.isArray(operation.input) ? operation.input : {};
      if (operation.action === 'search_issue') {
        emitStatus(onEvent, '白泽正在执行 Jira search_issue 实时查询。', { plugin: 'jira', action: operation.action, operationId: operation.id });
        const result = await transport.searchJiraIssues(serverUrl, {
          ...input,
          clientOperation: true,
          disableRecovery: true,
          clientId: chatInput.clientId,
          userId: chatInput.userId || 'desktop-user',
          conversationId: chatInput.conversationId
        }, { signal });
        return { ok: true, plugin: 'jira', action: operation.action, id: operation.id, result };
      }
      if (!jiraService) {
        return { ok: false, code: 'LOCAL_JIRA_SERVICE_UNAVAILABLE', message: '本机 Jira 创建服务不可用，请检查客户端配置。' };
      }
      if (operation.action === 'create_issue') {
        emitStatus(onEvent, '白泽正在生成 Jira 创建确认卡。', { plugin: 'jira', action: operation.action, operationId: operation.id });
        if (typeof jiraService.createJiraImportDraftsWithOperation !== 'function') {
          return { ok: false, code: 'LOCAL_JIRA_SERVICE_UNAVAILABLE', message: '本机 Jira 创建服务不可用，请检查客户端配置。' };
        }
        const result = await jiraService.createJiraImportDraftsWithOperation({
          fileName: input.fileName || 'local-claude-code-jira-intent.json',
          drafts: input.drafts,
          warnings: Array.isArray(input.warnings) ? input.warnings : [],
          clientId: chatInput.clientId,
          userId: chatInput.userId || 'desktop-user',
          conversationId: chatInput.conversationId
        }, { signal });
        const operationResult = { ok: true, plugin: 'jira', action: operation.action, id: operation.id, result, operation: result.operation };
        if (typeof onEvent === 'function' && result.operation) {
          onEvent({ type: 'jira_operation_required', message: '白泽：已生成 Jira 创建确认卡，请确认是否创建。', operation: result.operation });
        }
        return operationResult;
      }
      if (!confirmedJiraOperationId) {
        return { ok: false, code: 'JIRA_OPERATION_NOT_CONFIRMED', message: 'Jira 创建工具只能在用户确认创建后执行。' };
      }
      emitStatus(onEvent, describeJiraToolStart(operation.action, input), { plugin: 'jira', action: operation.action, operationId: operation.id });
      if (operation.action === 'get_project') {
        const result = await jiraService.getJiraProject(input);
        emitStatus(onEvent, describeJiraToolDone(operation.action, result), { plugin: 'jira', action: operation.action, operationId: operation.id });
        return { ok: true, plugin: 'jira', action: operation.action, id: operation.id, result };
      }
      if (operation.action === 'get_create_meta') {
        const result = await jiraService.getJiraCreateMeta(input);
        emitStatus(onEvent, describeJiraToolDone(operation.action, result), { plugin: 'jira', action: operation.action, operationId: operation.id });
        return { ok: true, plugin: 'jira', action: operation.action, id: operation.id, result };
      }
      if (operation.action === 'search_user') {
        const result = await jiraService.searchJiraUser(input);
        emitStatus(onEvent, describeJiraToolDone(operation.action, result), { plugin: 'jira', action: operation.action, operationId: operation.id });
        return { ok: true, plugin: 'jira', action: operation.action, id: operation.id, result };
      }
      const result = await jiraService.createConfirmedJiraIssue(confirmedJiraOperationId, input, {
        clientId: chatInput.clientId,
        userId: chatInput.userId || 'desktop-user',
        conversationId: chatInput.conversationId
      });
      emitStatus(onEvent, describeJiraToolDone(operation.action, result), { plugin: 'jira', action: operation.action, operationId: operation.id });
      if (typeof onEvent === 'function' && result.operation) {
        onEvent({ type: result.operation.status === 'created' ? 'jira_operation_created' : 'jira_operation_updated', operation: result.operation });
      }
      return { ok: result.ok !== false, plugin: 'jira', action: operation.action, id: operation.id, result, operation: result.operation };
    } catch (error) {
      return { ok: false, code: error.code || 'CLIENT_PLUGIN_OPERATION_FAILED', message: error.message || 'Jira 操作失败。' };
    }
  }

  async function syncLocalEvents(serverUrl, chatInput, result, onEvent) {
    const syncEvents = Array.isArray(result && result.syncEvents)
      ? result.syncEvents.filter((event) => event && isAllowedLocalSyncEventType(event.type))
      : [];
    if (syncEvents.length === 0) {
      return [];
    }
    const syncedEvents = [];
    for (const event of syncEvents) {
      try {
        const synced = await transport.appendSyncEvent(serverUrl, {
          type: event.type,
          clientId: chatInput.clientId,
          userId: chatInput.userId || 'desktop-user',
          clientCreatedAt: new Date().toISOString(),
          payload: event.payload
        });
        syncedEvents.push(synced && synced.event ? synced.event : synced);
      } catch (error) {
        if (typeof onEvent === 'function') {
          onEvent({ type: 'status', message: `白泽同步本地事件失败：${error.message || '未知错误'}` });
        }
      }
    }
    result.syncedEvents = syncedEvents;
    return syncedEvents;
  }

  async function handleChat(input = {}, options = {}) {
    const serverUrl = await getServerUrl();
    const config = await readRuntimeConfig(serverUrl);
    const useLocalClaudeCode = shouldUseLocalClaudeCode(config);
    const chatInput = await buildChatInput(input, useLocalClaudeCode ? serverUrl : null);
    if (useLocalClaudeCode) {
      const result = await localChat.send(chatInput, {
        ...options,
        localClaudeCodeEnv: getLocalClaudeCodeEnv(config),
        executeClientOperation: (operation) => executeClientOperation(serverUrl, chatInput, operation, options)
      });
      await syncLocalEvents(serverUrl, chatInput, result);
      return result;
    }
    return transport.sendChat(serverUrl, stripLocalOnlyChatInput(chatInput), options);
  }

  async function handleChatStream(input = {}, { signal, onEvent } = {}) {
    const serverUrl = await getServerUrl();
    const config = await readRuntimeConfig(serverUrl);
    const useLocalClaudeCode = shouldUseLocalClaudeCode(config);
    const chatInput = await buildChatInput(input, useLocalClaudeCode ? serverUrl : null);
    if (useLocalClaudeCode) {
      const result = await localChat.sendStream(chatInput, {
        signal,
        onEvent,
        localClaudeCodeEnv: getLocalClaudeCodeEnv(config),
        executeClientOperation: (operation) => executeClientOperation(serverUrl, chatInput, operation, { signal, onEvent })
      });
      await syncLocalEvents(serverUrl, chatInput, result, onEvent);
      return result;
    }
    return transport.sendChatStream(serverUrl, stripLocalOnlyChatInput(chatInput), { signal, onEvent });
  }

  async function confirmJiraOperation(operationId, input = {}, { signal, onEvent } = {}) {
    if (!jiraService || typeof jiraService.confirmJiraOperation !== 'function') {
      throw new Error('本机 Jira 创建服务不可用，请检查客户端配置。');
    }
    const serverUrl = await getServerUrl();
    const config = await readRuntimeConfig(serverUrl);
    if (!shouldUseLocalClaudeCode(config)) {
      throw new Error('本机 Claude Code 未启用，无法执行已确认的 Jira 操作。');
    }
    emitStatus(onEvent, '已确认 Jira 创建，正在启动本机 Claude Code 执行 Jira 插件。', { plugin: 'jira', action: 'confirm_operation', jiraOperationId: operationId });
    const confirmed = await jiraService.confirmJiraOperation(operationId, {
      ...input,
      clientId: input.clientId || await getClientId()
    });
    emitStatus(onEvent, '本机 Claude Code 正在读取已确认的 Jira 草稿。', { plugin: 'jira', action: 'prepare_confirmed_operation', jiraOperationId: operationId });
    const chatInput = await buildChatInput({
      text: '执行已确认的 Jira 创建操作',
      originalText: input.originalText || '',
      userId: input.userId || 'desktop-user',
      conversationId: confirmed.conversationId || input.conversationId,
      clientId: confirmed.clientId || input.clientId || await getClientId(),
      operation: confirmed
    }, serverUrl);
    const result = await localChat.send(chatInput, {
      signal,
      mode: 'jira_confirmed_execution',
      localClaudeCodeEnv: getLocalClaudeCodeEnv(config),
      executeClientOperation: (operation) => executeClientOperation(serverUrl, chatInput, operation, { signal, onEvent, confirmedJiraOperationId: operationId })
    });
    const latest = typeof jiraService.getJiraOperation === 'function' ? await jiraService.getJiraOperation(operationId) : confirmed;
    return { operation: latest, reply: result.reply, results: result.results || [] };
  }

  async function pullSyncEvents({ since, limit = 100 } = {}) {
    const serverUrl = await getServerUrl();
    const state = syncStore && typeof syncStore.getState === 'function' ? await syncStore.getState() : { lastVersion: 0 };
    const response = await transport.listSyncEvents(serverUrl, {
      since: since !== undefined ? since : state.lastVersion,
      limit
    });
    if (syncStore && typeof syncStore.applyEvents === 'function') {
      await syncStore.applyEvents(response.events || [], { lastVersion: response.lastVersion });
    }
    return response;
  }

  function isImageAttachmentInput(input = {}) {
    const type = String(input.type || '').toLowerCase();
    const fileName = String(input.fileName || '');
    const mimeType = String(input.mimeType || '');
    return type === 'image' || /^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/i.test(mimeType) || /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName);
  }

  async function analyzeImageAttachment(input = {}, { signal } = {}) {
    const serverUrl = await getServerUrl();
    const config = await readRuntimeConfig(serverUrl);
    if (!shouldUseLocalClaudeCode(config)) {
      const error = new Error('本机 Claude Code 未启用，无法分析图片。');
      error.code = 'LOCAL_CLAUDE_CODE_DISABLED';
      throw error;
    }
    return imageAnalyzer(input, {
      signal,
      localClaudeCodeEnv: getLocalClaudeCodeEnv(config)
    });
  }

  async function rememberAttachment(attachmentId, input = {}, { signal } = {}) {
    const serverUrl = await getServerUrl();
    if (!isImageAttachmentInput(input)) {
      return transport.rememberAttachment(serverUrl, attachmentId, input, { signal });
    }

    if (typeof input.localPath !== 'string' || input.localPath.trim() === '') {
      const error = new Error('图片加入记忆区前必须完成本机 Claude Code 视觉分析，但客户端没有保留本机图片路径。请重新拖入或粘贴图片后再试。');
      error.code = 'LOCAL_IMAGE_PATH_REQUIRED';
      throw error;
    }
    const clientAnalysis = sanitizeClientAnalysis(await analyzeImageAttachment({
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      localPath: input.localPath
    }, { signal }));

    return transport.rememberAttachment(serverUrl, attachmentId, {
      category: input.category,
      clientAnalysis
    }, { signal });
  }

  async function getControlPlaneStatus() {
    const serverUrl = await getServerUrl();
    const clientId = await getClientId();
    const [runtime, plugins] = await Promise.all([
      readRuntimeConfig(serverUrl),
      transport.getPluginUpdates(serverUrl).catch(() => ({ enabled: false, plugins: [] }))
    ]);
    return { clientId, runtime: redactRuntimeConfig(runtime), plugins };
  }

  return {
    handleChat,
    handleChatStream,
    confirmJiraOperation,
    analyzeImageAttachment,
    rememberAttachment,
    pullSyncEvents,
    getControlPlaneStatus
  };
}

module.exports = {
  createLocalRuntime
};
