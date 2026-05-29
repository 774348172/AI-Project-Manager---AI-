const state = {
  clientId: null,
  conversations: [],
  currentConversationId: null,
  sending: false,
  cancelling: false,
  activeRequestId: null,
  replyTimerId: null,
  replyStartedAt: null,
  pendingUploads: [],
  updateState: null,
  showServerActivity: true,
  serverActivityText: '',
  bugAnalysisPollers: new Map(),
  assistantActivityLimit: 12
};

const elements = {
  connectionStatus: document.getElementById('connectionStatus'),
  connectionDot: document.getElementById('connectionDot'),
  messages: document.getElementById('messages'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  pendingUploadTray: document.getElementById('pendingUploadTray'),
  sendButton: document.getElementById('sendButton'),
  newConversation: document.getElementById('newConversation'),
  conversationList: document.getElementById('conversationList'),
  activeConversationTitle: document.getElementById('activeConversationTitle'),
  replyTimer: document.getElementById('replyTimer'),
  updateStatus: document.getElementById('updateStatus'),
  updateStatusText: document.getElementById('updateStatusText'),
  updateProgressTrack: document.getElementById('updateProgressTrack'),
  updateProgressBar: document.getElementById('updateProgressBar'),
  updateAction: document.getElementById('updateAction'),
  windowMinimize: document.getElementById('windowMinimize'),
  windowMaximize: document.getElementById('windowMaximize'),
  windowClose: document.getElementById('windowClose')
};

function setConnectionStatus(text, variant) {
  const light = elements.connectionStatus.closest('.connection-light');
  if (light) {
    light.hidden = variant === 'ok';
  }
  elements.connectionStatus.textContent = text;
  elements.connectionDot.className = `connection-dot connection-${variant}`;
}

function isUpdateRequired() {
  return Boolean(state.updateState && state.updateState.versionStatus && state.updateState.versionStatus.updateRequired);
}

function updateSendButton() {
  elements.sendButton.disabled = state.cancelling || isUpdateRequired();
  elements.sendButton.textContent = state.sending ? (state.cancelling ? '取消中' : '取消') : '发送';
}

function renderUpdateState(updateState) {
  state.updateState = updateState;
  const showUpdateStatus = updateState
    && updateState.versionStatus
    && updateState.versionStatus.enabled
    && (updateState.versionStatus.updateAvailable || ['checking', 'downloading', 'downloaded', 'error'].includes(updateState.status));
  if (!showUpdateStatus) {
    elements.updateStatus.hidden = true;
    updateSendButton();
    return;
  }

  elements.updateStatus.hidden = false;
  elements.updateStatus.className = `update-status update-${updateState.status || 'idle'}${updateState.versionStatus.updateRequired ? ' update-required' : ''}`;
  elements.updateStatusText.textContent = updateState.versionStatus.updateRequired
    ? `${updateState.message || '发现强制更新。'} 必须更新后才能继续使用。`
    : updateState.message || '客户端更新状态未知。';
  const isDownloading = updateState.status === 'downloading';
  const progress = Number.isFinite(updateState.progress) ? Math.max(0, Math.min(100, updateState.progress)) : 0;
  elements.updateProgressTrack.hidden = !isDownloading;
  elements.updateProgressBar.style.width = `${isDownloading ? progress : 0}%`;
  elements.updateAction.hidden = isDownloading || !['available', 'downloaded', 'error'].includes(updateState.status);
  elements.updateAction.textContent = updateState.status === 'downloaded' ? '重启安装' : '下载更新';
  updateSendButton();
}

function describeError(error) {
  const message = error && error.message ? error.message : '';
  const cleanMessage = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();

  if (!cleanMessage) {
    return '操作失败，请稍后重试。';
  }

  if (cleanMessage.includes('已取消本次回答') || cleanMessage.includes('BAIZE_REQUEST_CANCELLED')) {
    return '已取消本次回答。';
  }

  if (cleanMessage === 'Route not found.') {
    return '白泽服务器版本过旧，缺少当前客户端需要的接口。请重启服务器或更新服务器后再试。';
  }

  if (cleanMessage === 'Internal server error.') {
    return '白泽服务器内部错误，请稍后重试或查看服务器日志。';
  }

  if (cleanMessage.includes('fetch failed') || cleanMessage.includes('ECONNREFUSED')) {
    return '无法连接白泽服务器。请确认服务器已启动后重试。';
  }

  return cleanMessage;
}

function formatTime(value) {
  if (!value) {
    return '';
  }

  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function updateReplyTimer() {
  const seconds = Math.max(0, Math.floor((Date.now() - state.replyStartedAt) / 1000));
  const activity = state.serverActivityText ? `｜${state.serverActivityText}` : '';
  elements.replyTimer.textContent = `等待白泽回复：${seconds} 秒${activity}`;
}

function startReplyTimer() {
  state.replyStartedAt = Date.now();
  state.serverActivityText = '';
  elements.replyTimer.hidden = false;
  updateReplyTimer();
  state.replyTimerId = setInterval(updateReplyTimer, 1000);
}

function stopReplyTimer() {
  if (state.replyTimerId) {
    clearInterval(state.replyTimerId);
  }
  state.replyTimerId = null;
  state.replyStartedAt = null;
  state.serverActivityText = '';
  elements.replyTimer.hidden = true;
}

function currentConversation() {
  return state.conversations.find((conversation) => conversation.id === state.currentConversationId) || null;
}

function hideConversationMenu() {
  const menu = document.querySelector('.conversation-context-menu');
  if (menu) {
    menu.remove();
  }
}

async function deleteConversation(conversation) {
  hideConversationMenu();
  if (state.sending) {
    return;
  }
  try {
    await window.baize.deleteConversation(conversation.id);
    state.conversations = await window.baize.listConversations();
    if (state.conversations.length === 0) {
      const next = await window.baize.createConversation({ title: '新会话' });
      state.conversations = [next];
    }
    if (state.currentConversationId === conversation.id) {
      state.currentConversationId = state.conversations[0].id;
    }
    renderConversationList();
    await renderActiveConversation();
  } catch (error) {
    window.alert(describeError(error));
  }
}

function showConversationMenu(event, conversation) {
  event.preventDefault();
  hideConversationMenu();

  const menu = document.createElement('div');
  menu.className = 'conversation-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.textContent = '删除会话';
  deleteButton.addEventListener('click', () => deleteConversation(conversation));
  menu.appendChild(deleteButton);

  document.body.appendChild(menu);
}

function renderConversationList() {
  elements.conversationList.replaceChildren();
  if (state.conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有会话。';
    elements.conversationList.appendChild(empty);
    return;
  }

  for (const conversation of state.conversations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `history-tab${conversation.id === state.currentConversationId ? ' active' : ''}`;
    button.addEventListener('click', () => selectConversation(conversation.id));
    button.addEventListener('contextmenu', (event) => showConversationMenu(event, conversation));

    const title = document.createElement('div');
    title.className = 'history-tab-title';
    title.textContent = conversation.title || '新会话';
    button.appendChild(title);

    const time = document.createElement('div');
    time.className = 'history-tab-time';
    time.textContent = formatTime(conversation.updatedAt);
    button.appendChild(time);

    elements.conversationList.appendChild(button);
  }
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = `message message-${message.role}`;

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = message.role === 'user' ? '你' : '白泽';
  article.appendChild(label);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = message.text;
  article.appendChild(body);

  if (Array.isArray(message.results) && message.results.length > 0) {
    const list = document.createElement('ul');
    list.className = 'source-list';
    for (const result of message.results) {
      const item = document.createElement('li');
      item.textContent = `${result.title || '未命名'} · ${result.relativePath || result.source || 'local'}`;
      list.appendChild(item);
    }
    article.appendChild(list);
  }

  if (message.claudeCodeOperation) {
    renderClaudeCodeOperationCard(article, message.claudeCodeOperation);
  }

  if (message.jiraOperation) {
    renderJiraCreateOperationCard(article, message.jiraOperation);
  }

  if (message.jiraSearchSupplement) {
    renderJiraSearchSupplementCard(article, message.jiraSearchSupplement);
  }

  if (message.jiraAudit) {
    renderJiraAuditCard(article, message.jiraAudit);
  }

  if (message.bugAnalysisRun) {
    renderBugAnalysisRunCard(article, message.bugAnalysisRun);
  } else if (message.role === 'assistant') {
    const bugRunMatch = String(message.text || '').match(/bug-run-[a-f0-9-]+/i);
    if (bugRunMatch && window.baize && typeof window.baize.getBugAnalysisRun === 'function') {
      window.baize.getBugAnalysisRun(bugRunMatch[0]).then((response) => {
        const run = response.run || response;
        if (run && run.id && !article.querySelector('.bug-analysis-card')) {
          renderBugAnalysisRunCard(article, run);
        }
      }).catch(() => {});
    }
  }

  if (message.attachment) {
    renderAttachmentCard(article, message.attachment);
  }

  if (message.meta) {
    const footer = document.createElement('div');
    footer.className = 'message-meta';
    footer.textContent = message.meta;
    article.appendChild(footer);
  }

  elements.messages.appendChild(article);
}

function renderCardStatus(card, text, variant = '') {
  const status = card.querySelector('.operation-status');
  if (!status) {
    return;
  }
  status.textContent = text;
  status.className = `operation-status${variant ? ` operation-status-${variant}` : ''}`;
}

function isActiveBugAnalysisRun(run) {
  return run && !['completed', 'cancelled', 'timed_out', 'superseded', 'awaiting_comment_confirmation'].includes(run.status);
}

function formatBugAnalysisStatus(run) {
  return `状态：${run.status || 'unknown'}；总数 ${run.total || 0}，完成 ${run.completed || 0}，失败 ${run.failed || 0}，待确认 ${(run.items || []).filter((item) => item.status === 'awaiting_comment_confirmation').length}，分析中 ${(run.items || []).filter((item) => item.status === 'analyzing').length}`;
}

function renderBugAnalysisRunCard(container, initialRun) {
  if (!container || !initialRun || !initialRun.id) {
    return null;
  }
  const card = document.createElement('section');
  card.className = 'operation-card bug-analysis-card';
  container.appendChild(card);

  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = `Jira BUG 工程分析：${initialRun.id}`;
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  card.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'bug-analysis-items';
  card.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  card.appendChild(actions);

  async function refresh(run = initialRun) {
    summary.textContent = formatBugAnalysisStatus(run);
    list.replaceChildren();
    for (const item of run.items || []) {
      const itemEl = document.createElement('div');
      itemEl.className = 'bug-analysis-item';
      const head = document.createElement('div');
      head.className = 'bug-analysis-item-head';
      head.textContent = `${item.issueKey || item.id}：${item.status}`;
      itemEl.appendChild(head);
      if (item.error) {
        const error = document.createElement('div');
        error.className = 'operation-status operation-status-error';
        error.textContent = item.error;
        itemEl.appendChild(error);
      }
      if (item.commentDraft && !['cancelled', 'timed_out', 'superseded'].includes(run.status)) {
        const draft = document.createElement('pre');
        draft.className = 'bug-analysis-draft';
        draft.textContent = item.commentDraft;
        itemEl.appendChild(draft);
      }
      if (item.status === 'awaiting_comment_confirmation' && item.commentDraft && !['cancelled', 'timed_out', 'superseded'].includes(run.status)) {
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'operation-primary';
        confirm.textContent = '写入 Jira 评论';
        confirm.addEventListener('click', async () => {
          const response = await window.baize.confirmBugAnalysisComment(run.id, item.id, { clientId: state.clientId });
          await refresh(response.run || response);
        });
        itemEl.appendChild(confirm);
      }
      if (item.status === 'recovery_required') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试分析';
        retry.addEventListener('click', async () => {
          const response = await window.baize.applyBugAnalysisRecovery(run.id, item.id, { actionId: 'retry_analysis', clientId: state.clientId });
          await refresh(response.run || response);
        });
        itemEl.appendChild(retry);
      }
      list.appendChild(itemEl);
    }
    actions.replaceChildren();
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.textContent = '刷新';
    refreshButton.addEventListener('click', async () => {
      const response = await window.baize.getBugAnalysisRun(run.id);
      await refresh(response.run || response);
    });
    actions.appendChild(refreshButton);
    if (isActiveBugAnalysisRun(run)) {
      const resumeButton = document.createElement('button');
      resumeButton.type = 'button';
      resumeButton.textContent = '继续/恢复';
      resumeButton.addEventListener('click', async () => {
        const response = await window.baize.resumeBugAnalysisRun(run.id, { clientId: state.clientId });
        await refresh(response.run || response);
      });
      actions.appendChild(resumeButton);
    }
  }

  refresh(initialRun);
  window.baize.getBugAnalysisRun(initialRun.id).then((response) => refresh(response.run || response)).catch(() => {});
  if (isActiveBugAnalysisRun(initialRun) && !state.bugAnalysisPollers.has(initialRun.id)) {
    const timer = setInterval(async () => {
      try {
        const response = await window.baize.getBugAnalysisRun(initialRun.id);
        const run = response.run || response;
        await refresh(run);
        if (!isActiveBugAnalysisRun(run)) {
          clearInterval(timer);
          state.bugAnalysisPollers.delete(initialRun.id);
        }
      } catch {
        clearInterval(timer);
        state.bugAnalysisPollers.delete(initialRun.id);
      }
    }, 5000);
    state.bugAnalysisPollers.set(initialRun.id, timer);
  }
  return card;
}

function renderAttachmentCard(container, attachment) {
  const card = document.createElement('section');
  card.className = 'operation-card attachment-card';
  container.appendChild(card);

  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = `上传文件：${attachment.fileName || '未命名文件'}`;
  card.appendChild(title);

  const isImage = attachment.type === 'image' || /^image\//i.test(attachment.mimeType || '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(attachment.fileName || '');
  const isPendingImageAnalysis = isImage && (!attachment.analysis || attachment.analysis.provider === 'local_claude_code_pending');
  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  summary.textContent = isPendingImageAnalysis
    ? '图片已上传。'
    : attachment.analysis && attachment.analysis.summary ? attachment.analysis.summary : '白泽已收到文件。';
  card.appendChild(summary);

  const reason = document.createElement('div');
  reason.className = 'operation-workspace';
  reason.textContent = isPendingImageAnalysis
    ? '记忆建议：点击加入记忆区后，将由客户端本机 Claude Code 进行视觉分析。'
    : attachment.analysis && attachment.analysis.reason ? `记忆建议：${attachment.analysis.reason}` : '记忆建议：等待确认。';
  card.appendChild(reason);

  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  const rememberButton = document.createElement('button');
  rememberButton.type = 'button';
  rememberButton.className = 'operation-primary';
  rememberButton.textContent = '加入记忆区';
  const skipButton = document.createElement('button');
  skipButton.type = 'button';
  skipButton.textContent = '暂不加入';
  actions.append(rememberButton, skipButton);
  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = attachment.memory && attachment.memory.status === 'remembered' ? '已加入记忆区。' : '请确认是否加入白泽记忆区。';
  card.appendChild(status);

  if (attachment.memory && attachment.memory.status === 'remembered') {
    rememberButton.disabled = true;
    skipButton.disabled = true;
  }

  rememberButton.addEventListener('click', async () => {
    try {
      rememberButton.disabled = true;
      skipButton.disabled = true;
      renderCardStatus(card, isImage ? '正在进行图片视觉分析并加入记忆区。' : '正在加入记忆区。');
      const response = await window.baize.rememberAttachment(attachment.id, {
        category: attachment.memory && attachment.memory.category ? attachment.memory.category : 'project',
        type: attachment.type,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        localPath: attachment.localPath,
        clientAnalysis: isImage ? undefined : attachment.analysis
      });
      const updated = response.attachment || response;
      renderCardStatus(card, `已加入记忆区：${updated.memory.category}`, 'ok');
    } catch (error) {
      renderCardStatus(card, describeError(error), 'error');
      rememberButton.disabled = false;
      skipButton.disabled = false;
    }
  });

  skipButton.addEventListener('click', () => {
    rememberButton.disabled = true;
    skipButton.disabled = true;
    renderCardStatus(card, '已跳过，不加入记忆区。');
  });

  return card;
}

function appendOperationFileList(parent, files) {
  const list = document.createElement('ul');
  list.className = 'operation-file-list';
  for (const file of files || []) {
    const item = document.createElement('li');
    item.textContent = `${file.path}（+${file.additions || 0} / -${file.deletions || 0}）`;
    list.appendChild(item);
  }
  parent.appendChild(list);
}

async function getActiveWorkspaceText() {
  const workspaceList = await window.baize.listWorkspaces();
  const active = workspaceList.workspaces.find((workspace) => workspace.id === workspaceList.activeWorkspaceId);
  return active ? active.rootPath : '未选择本地工作区';
}

function renderPatchApplyPanel(card, operation) {
  card.replaceChildren();
  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = 'Claude Code 补丁草案';
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  summary.textContent = operation.proposal && operation.proposal.summary ? operation.proposal.summary : '补丁草案已生成。';
  card.appendChild(summary);
  appendOperationFileList(card, operation.proposal ? operation.proposal.files : []);

  const workspace = document.createElement('div');
  workspace.className = 'operation-workspace';
  workspace.textContent = '本地工作区：加载中';
  card.appendChild(workspace);
  getActiveWorkspaceText()
    .then((text) => { workspace.textContent = `本地工作区：${text}`; })
    .catch(() => { workspace.textContent = '本地工作区：未选择本地工作区'; });

  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  const chooseButton = document.createElement('button');
  chooseButton.type = 'button';
  chooseButton.textContent = '选择本地工作区';
  const previewButton = document.createElement('button');
  previewButton.type = 'button';
  previewButton.textContent = '预览补丁';
  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'operation-primary';
  applyButton.textContent = '应用到本地工作区';
  actions.append(chooseButton, previewButton, applyButton);
  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = '应用前请确认工作区路径和文件列表。';
  card.appendChild(status);

  chooseButton.addEventListener('click', async () => {
    try {
      chooseButton.disabled = true;
      const selected = await window.baize.authorizeWorkspace();
      workspace.textContent = selected ? `本地工作区：${selected.rootPath}` : '本地工作区：未选择本地工作区';
    } catch (error) {
      renderCardStatus(card, describeError(error), 'error');
    } finally {
      chooseButton.disabled = false;
    }
  });

  previewButton.addEventListener('click', async () => {
    try {
      previewButton.disabled = true;
      const preview = await window.baize.previewPatch({ patch: operation.proposal.patch });
      renderCardStatus(card, `预览通过：${preview.files.length} 个文件可应用。`, 'ok');
    } catch (error) {
      renderCardStatus(card, describeError(error), 'error');
    } finally {
      previewButton.disabled = false;
    }
  });

  applyButton.addEventListener('click', async () => {
    if (!window.confirm('确认要把这个补丁应用到当前本地工作区吗？')) {
      return;
    }
    try {
      applyButton.disabled = true;
      const result = await window.baize.applyPatch({ patch: operation.proposal.patch });
      await window.baize.reportClaudeCodeApplicationResult(operation.id, {
        conversationId: operation.conversationId,
        clientId: state.clientId,
        status: 'applied',
        appliedFiles: result.appliedFiles
      });
      renderCardStatus(card, `已应用：${result.appliedFiles.join('、')}`, 'ok');
    } catch (error) {
      await window.baize.reportClaudeCodeApplicationResult(operation.id, {
        conversationId: operation.conversationId,
        clientId: state.clientId,
        status: 'apply_failed',
        error: describeError(error)
      }).catch(() => null);
      renderCardStatus(card, describeError(error), 'error');
      applyButton.disabled = false;
    }
  });
}

function appendJiraDraftList(parent, drafts) {
  const displayLimit = 100;
  const visibleDrafts = drafts.slice(0, displayLimit);
  const list = document.createElement('ul');
  list.className = 'operation-file-list';
  for (const draft of visibleDrafts) {
    const item = document.createElement('li');
    item.textContent = `${draft.summary}（项目：${draft.projectKey || '未设置'}，类型：${draft.issueType || 'Task'}${draft.assignee ? `，负责人：${draft.assignee}` : ''}）`;
    list.appendChild(item);
  }
  parent.appendChild(list);
  if (drafts.length > displayLimit) {
    const notice = document.createElement('div');
    notice.className = 'operation-workspace';
    notice.textContent = `当前共有 ${drafts.length} 条需求单草稿，界面只展示前 ${displayLimit} 条，确认创建时仍会按全部草稿执行。`;
    parent.appendChild(notice);
  }
}

function renderJiraCreatedPanel(card, operation) {
  card.replaceChildren();
  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = 'Jira 创建成功';
  card.appendChild(title);

  const created = Array.isArray(operation.createdIssues) ? operation.createdIssues : [];
  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  summary.textContent = created.length > 0 ? `已创建：${created.map((issue) => issue.key).filter(Boolean).join('、')}` : 'Jira 单创建成功。';
  card.appendChild(summary);
}

function renderJiraRunningPanel(card, operation) {
  card.replaceChildren();
  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = 'Jira 正在创建';
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  const created = Array.isArray(operation.createdIssues) ? operation.createdIssues : [];
  summary.textContent = created.length > 0 ? `Claude Code 已创建 ${created.length} 个 Jira 单，正在继续处理剩余草稿。` : 'Claude Code 正在调用 Jira 插件执行已确认的创建操作。';
  card.appendChild(summary);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = '正在等待本机 Claude Code 返回下一步 Jira 工具调用。';
  card.appendChild(status);
}

function appendRecoverySupplement(parent, supplement) {
  const inputValues = {};
  if (!supplement || !Array.isArray(supplement.inputs) || supplement.inputs.length === 0) {
    return inputValues;
  }
  const prompt = document.createElement('div');
  prompt.className = 'operation-workspace';
  prompt.textContent = supplement.prompt || '请补充信息。';
  parent.appendChild(prompt);
  for (const item of supplement.inputs) {
    const wrapper = document.createElement('label');
    wrapper.className = 'operation-workspace';
    const label = document.createElement('div');
    label.textContent = item.label || item.id;
    wrapper.appendChild(label);
    const input = item.type === 'select' ? document.createElement('select') : document.createElement('input');
    input.dataset.recoveryInputId = item.id;
    if (item.type === 'select') {
      for (const optionValue of item.options || []) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue;
        input.appendChild(option);
      }
    } else {
      input.type = 'text';
    }
    wrapper.appendChild(input);
    parent.appendChild(wrapper);
    inputValues[item.id] = input;
  }
  return inputValues;
}

function renderJiraRecoveryPanel(card, operation) {
  card.replaceChildren();
  const recovery = operation.recovery || {};
  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = 'Jira 创建失败，可尝试恢复';
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  summary.textContent = recovery.summary || '白泽已分析这次 Jira 创建失败。';
  card.appendChild(summary);

  if (operation.error) {
    const error = document.createElement('div');
    error.className = 'operation-status operation-status-error';
    error.textContent = `错误：${operation.error}`;
    card.appendChild(error);
  }

  if (recovery.reason) {
    const reason = document.createElement('div');
    reason.className = 'operation-workspace';
    reason.textContent = `原因：${recovery.reason}`;
    card.appendChild(reason);
  }

  const createdCount = Array.isArray(operation.createdIssues) ? operation.createdIssues.length : 0;
  if (createdCount > 0) {
    const partial = document.createElement('div');
    partial.className = 'operation-workspace';
    partial.textContent = `已创建 ${createdCount} 个，恢复只处理剩余草稿。`;
    card.appendChild(partial);
  }

  const inputValues = appendRecoverySupplement(card, recovery.supplement);
  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  const buttons = [];
  for (const action of recovery.actions || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label || action.id;
    if (action.style === 'primary') {
      button.className = 'operation-primary';
    }
    buttons.push(button);
    actions.appendChild(button);
    button.addEventListener('click', async () => {
      if (action.requiresConfirmation && !window.confirm(action.description || '确认执行这个恢复操作吗？')) {
        return;
      }
      const inputs = Object.fromEntries(Object.entries(inputValues).map(([id, input]) => [id, input.value]));
      try {
        buttons.forEach((item) => { item.disabled = true; });
        renderCardStatus(card, '正在执行恢复操作。');
        const response = await window.baize.recoverJiraOperation(operation.id, {
          conversationId: operation.conversationId,
          clientId: state.clientId,
          actionId: action.id,
          inputs
        });
        const updated = response.operation || response;
        if (updated.status === 'created') {
          renderJiraCreatedPanel(card, updated);
        } else if (updated.status === 'awaiting_confirmation') {
          renderJiraCreateOperationCard(card.parentElement, updated);
          card.remove();
        } else if (updated.status === 'recovery_required') {
          renderJiraRecoveryPanel(card, updated);
        } else if (updated.status === 'rejected') {
          renderCardStatus(card, '已取消 Jira 创建。');
        } else {
          renderCardStatus(card, updated.error || '恢复操作未完成。', 'error');
        }
      } catch (error) {
        renderCardStatus(card, describeError(error), 'error');
        buttons.forEach((item) => { item.disabled = false; });
      }
    });
  }
  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = '请选择下一步操作。';
  card.appendChild(status);
}

function renderJiraCreateOperationCard(container, operation) {
  const card = document.createElement('section');
  card.className = 'operation-card';
  container.appendChild(card);

  if (operation.status === 'created') {
    renderJiraCreatedPanel(card, operation);
    return card;
  }

  if (operation.status === 'confirmed_running') {
    renderJiraRunningPanel(card, operation);
    return card;
  }

  if (operation.status === 'recovery_required') {
    renderJiraRecoveryPanel(card, operation);
    return card;
  }

  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = 'Jira 批量创建确认';
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  summary.textContent = `已解析 ${operation.draftImport.count} 个 Jira 需求单草稿，确认后会写入 Jira。`;
  card.appendChild(summary);
  appendJiraDraftList(card, operation.draftImport.drafts || []);

  if (operation.draftImport.warnings && operation.draftImport.warnings.length > 0) {
    const warning = document.createElement('div');
    warning.className = 'operation-status operation-status-error';
    warning.textContent = operation.draftImport.warnings.join(' ');
    card.appendChild(warning);
  }

  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'operation-primary';
  confirmButton.textContent = '确认创建 Jira 单';
  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.textContent = '取消';
  actions.append(confirmButton, rejectButton);
  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = '确认前不会创建 Jira 单。';
  card.appendChild(status);

  confirmButton.addEventListener('click', async () => {
    try {
      confirmButton.disabled = true;
      rejectButton.disabled = true;
      renderCardStatus(card, '正在交给本机 Claude Code 调用 Jira 插件创建。');
      const response = await window.baize.confirmJiraOperation(operation.id, {
        conversationId: operation.conversationId,
        clientId: state.clientId
      }, (event) => {
        if (event && event.message) {
          renderCardStatus(card, event.message);
        }
      });
      const updated = response.operation || response;
      if (updated.status === 'recovery_required' || updated.status === 'failed') {
        renderJiraRecoveryPanel(card, updated);
      } else if (updated.status === 'created') {
        renderJiraCreatedPanel(card, updated);
      } else if (updated.status === 'confirmed_running') {
        renderJiraRunningPanel(card, updated);
      } else {
        renderCardStatus(card, updated.error || 'Jira 操作未完成，请查看状态后重试。', 'error');
        confirmButton.disabled = false;
        rejectButton.disabled = false;
      }
    } catch (error) {
      const operationFromError = error && error.data && error.data.operation;
      if (operationFromError) {
        renderJiraCreateOperationCard(container, operationFromError);
        card.remove();
        return;
      }
      renderCardStatus(card, describeError(error), 'error');
      confirmButton.disabled = false;
      rejectButton.disabled = false;
    }
  });

  rejectButton.addEventListener('click', async () => {
    try {
      confirmButton.disabled = true;
      rejectButton.disabled = true;
      await window.baize.rejectJiraOperation(operation.id, {
        conversationId: operation.conversationId,
        clientId: state.clientId
      });
      renderCardStatus(card, '已取消 Jira 创建。');
    } catch (error) {
      renderCardStatus(card, describeError(error), 'error');
      confirmButton.disabled = false;
      rejectButton.disabled = false;
    }
  });

  return card;
}

function renderJiraAuditCard(container, event) {
  if (!container || !event || !Array.isArray(event.perIssue)) {
    return null;
  }
  const card = document.createElement('section');
  card.className = 'operation-card jira-audit-card';

  const title = document.createElement('div');
  title.className = 'operation-title';
  const decisionLabel = event.decision === 'allow' ? '已放行' : event.decision === 'deny' ? '已拒绝' : '需要确认';
  title.textContent = `审计官评估 ${event.kind || 'Jira 操作'}：${decisionLabel}`;
  card.appendChild(title);

  if (event.summary) {
    const summary = document.createElement('div');
    summary.className = 'operation-body';
    summary.textContent = event.summary;
    card.appendChild(summary);
  }

  const list = document.createElement('ul');
  list.className = 'jira-audit-card-list';
  for (const item of event.perIssue) {
    const li = document.createElement('li');
    const cls = item.decision === 'allow'
      ? 'jira-audit-item-allow'
      : item.decision === 'deny'
        ? 'jira-audit-item-deny'
        : 'jira-audit-item-confirm';
    li.className = cls;
    const tag = item.decision === 'allow' ? '放行' : item.decision === 'deny' ? '拒绝' : '需要确认';
    const origin = item.aiCreated ? 'AI 创建' : '非 AI 单';
    li.textContent = `${item.issueKey}（${origin}）：${tag} —— ${item.reason || ''}`;
    list.appendChild(li);
  }
  card.appendChild(list);

  if (event.decision === 'require_confirmation') {
    const actions = document.createElement('div');
    actions.className = 'operation-actions';

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'operation-primary';
    confirmButton.textContent = '允许执行';
    actions.appendChild(confirmButton);

    const rejectButton = document.createElement('button');
    rejectButton.type = 'button';
    rejectButton.className = 'operation-secondary';
    rejectButton.textContent = '取消';
    actions.appendChild(rejectButton);
    card.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'operation-status';
    card.appendChild(status);

    if (!event.auditId) {
      status.textContent = '审计 ID 缺失，无法继续。';
      confirmButton.disabled = true;
      rejectButton.disabled = true;
    } else {
      confirmButton.addEventListener('click', async () => {
        confirmButton.disabled = true;
        rejectButton.disabled = true;
        status.textContent = '审计官在执行已确认动作…';
        try {
          const response = await window.baize.confirmPluginAudit(event.auditId);
          const payload = response && typeof response === 'object' && response.data && typeof response.data === 'object'
            ? response.data
            : response;
          if (payload && payload.error) {
            status.textContent = `执行失败：${payload.error}`;
            return;
          }
          if (payload && payload.status === 'executed') {
            const inner = payload.result || {};
            status.textContent = `已执行：${inner.reply || '完成'}`;
          } else if (payload && payload.status === 'failed') {
            status.textContent = `执行失败：${payload.error || '未知错误'}`;
          } else {
            status.textContent = '已确认。';
          }
        } catch (error) {
          status.textContent = `执行失败：${error && error.message || '未知错误'}`;
        }
      });
      rejectButton.addEventListener('click', async () => {
        confirmButton.disabled = true;
        rejectButton.disabled = true;
        try {
          await window.baize.rejectPluginAudit(event.auditId);
          status.textContent = '已取消，未对 Jira 做任何修改。';
        } catch (error) {
          status.textContent = `取消失败：${error && error.message || '未知错误'}`;
        }
      });
    }
  }

  container.appendChild(card);
  return card;
}

function renderJiraCommentPreviewCard(container, event) {
  if (!container) {
    return null;
  }
  const entries = Array.isArray(event.entries) && event.entries.length > 0
    ? event.entries
        .map((entry) => entry && entry.issueKey && entry.body ? { issueKey: entry.issueKey, body: entry.body, sources: Array.isArray(entry.sources) ? entry.sources : [] } : null)
        .filter(Boolean)
    : (event.issueKey && event.body ? [{ issueKey: event.issueKey, body: event.body, sources: Array.isArray(event.sources) ? event.sources : [] }] : []);
  if (entries.length === 0) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'operation-card jira-comment-preview';

  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = entries.length > 1
    ? `Claude Code 为 ${entries.length} 个 Jira 单分别起草的评论`
    : `Claude Code 为 ${entries[0].issueKey} 起草的评论`;
  card.appendChild(title);

  if (entries.length > 1) {
    const list = document.createElement('ul');
    list.className = 'jira-comment-preview-targets';
    for (const entry of entries) {
      const item = document.createElement('li');
      item.dataset.issueKey = entry.issueKey;
      const head = document.createElement('div');
      head.className = 'jira-comment-preview-target-head';
      head.textContent = `${entry.issueKey}：待写入`;
      item.appendChild(head);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'jira-comment-preview-target-body';
      bodyEl.textContent = entry.body;
      item.appendChild(bodyEl);
      const sources = Array.isArray(entry.sources) ? entry.sources.filter((source) => source && source.ref) : [];
      if (sources.length > 0) {
        const sourceList = document.createElement('ul');
        sourceList.className = 'jira-comment-preview-sources';
        for (const source of sources.slice(0, 12)) {
          const sourceItem = document.createElement('li');
          sourceItem.textContent = `${source.type === 'file' ? '文件' : source.type === 'jira' ? 'Jira' : source.type === 'url' ? '链接' : '备注'}：${source.label || source.ref}`;
          sourceList.appendChild(sourceItem);
        }
        item.appendChild(sourceList);
      }
      list.appendChild(item);
    }
    card.appendChild(list);
  } else {
    const entry = entries[0];
    const bodyEl = document.createElement('div');
    bodyEl.className = 'operation-body';
    bodyEl.textContent = entry.body;
    card.appendChild(bodyEl);
    const sources = Array.isArray(entry.sources) ? entry.sources.filter((source) => source && source.ref) : [];
    if (sources.length > 0) {
      const sourcesTitle = document.createElement('div');
      sourcesTitle.className = 'operation-subtitle';
      sourcesTitle.textContent = '引用素材';
      card.appendChild(sourcesTitle);
      const sourceList = document.createElement('ul');
      sourceList.className = 'jira-comment-preview-sources';
      for (const source of sources.slice(0, 12)) {
        const sourceItem = document.createElement('li');
        sourceItem.textContent = `${source.type === 'file' ? '文件' : source.type === 'jira' ? 'Jira' : source.type === 'url' ? '链接' : '备注'}：${source.label || source.ref}`;
        sourceList.appendChild(sourceItem);
      }
      card.appendChild(sourceList);
    }
  }

  container.appendChild(card);
  return card;
}

function updateJiraCommentPreviewResult(card, result) {
  if (!card || !result || !result.issueKey) {
    return;
  }
  const item = card.querySelector(`.jira-comment-preview-targets li[data-issue-key="${result.issueKey}"]`);
  if (!item) {
    return;
  }
  const head = item.querySelector('.jira-comment-preview-target-head') || item;
  if (result.status === 'ok') {
    head.textContent = `${result.issueKey}：写入成功`;
    item.classList.add('jira-comment-preview-target-ok');
  } else {
    head.textContent = `${result.issueKey}：失败 ${result.error || ''}`.trim();
    item.classList.add('jira-comment-preview-target-failed');
  }
}

function renderJiraSearchSupplementCard(container, supplement) {
  const card = document.createElement('section');
  card.className = 'operation-card';
  container.appendChild(card);

  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = 'Jira 查询需要确认用户';
  card.appendChild(title);

  const inputValues = appendRecoverySupplement(card, supplement);
  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'operation-primary';
  button.textContent = '按所选用户继续查询';
  actions.appendChild(button);
  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = '选择后会作为新的 Jira 查询消息发送。';
  card.appendChild(status);

  button.addEventListener('click', async () => {
    const firstInput = Object.values(inputValues)[0];
    if (!firstInput || !firstInput.value) {
      renderCardStatus(card, '请选择 Jira 用户。', 'error');
      return;
    }
    elements.chatInput.value = `${firstInput.value}的 Jira 需求单`;
    await sendMessage();
  });

  return card;
}

function renderClaudeCodeOperationCard(container, operation) {
  const card = document.createElement('section');
  card.className = 'operation-card';
  container.appendChild(card);

  if (operation.status === 'awaiting_local_apply' && operation.proposal && operation.proposal.patch) {
    renderPatchApplyPanel(card, operation);
    return card;
  }

  const title = document.createElement('div');
  title.className = 'operation-title';
  title.textContent = '需要确认后生成代码补丁';
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'operation-summary';
  summary.textContent = '白泽可以让服务器端 Claude Code 生成补丁草案，但不会直接修改你的本地文件。';
  card.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'operation-actions';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'operation-primary';
  confirmButton.textContent = '生成补丁草案';
  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.textContent = '取消';
  actions.append(confirmButton, rejectButton);
  card.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'operation-status';
  status.textContent = operation.expiresAt ? `有效期至：${formatTime(operation.expiresAt)}` : '';
  card.appendChild(status);

  confirmButton.addEventListener('click', async () => {
    try {
      confirmButton.disabled = true;
      rejectButton.disabled = true;
      renderCardStatus(card, '正在生成补丁草案。');
      const response = await window.baize.confirmClaudeCodeOperation(operation.id, {
        conversationId: operation.conversationId,
        clientId: state.clientId
      });
      renderPatchApplyPanel(card, response.operation || response);
    } catch (error) {
      renderCardStatus(card, describeError(error), 'error');
      confirmButton.disabled = false;
      rejectButton.disabled = false;
    }
  });

  rejectButton.addEventListener('click', async () => {
    try {
      confirmButton.disabled = true;
      rejectButton.disabled = true;
      await window.baize.rejectClaudeCodeOperation(operation.id, {
        conversationId: operation.conversationId,
        clientId: state.clientId
      });
      renderCardStatus(card, '已取消。');
    } catch (error) {
      renderCardStatus(card, describeError(error), 'error');
      confirmButton.disabled = false;
      rejectButton.disabled = false;
    }
  });

  return card;
}

function renderStreamingAssistantMessage() {
  const article = document.createElement('article');
  article.className = 'message message-assistant';

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = '白泽';
  article.appendChild(label);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = '';
  article.appendChild(body);

  elements.messages.appendChild(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return body;
}

function ensureAssistantActivityPanel(assistantBody) {
  if (!assistantBody || !assistantBody.parentElement) {
    return null;
  }
  let panel = assistantBody.parentElement.querySelector('.assistant-activity');
  if (panel) {
    return panel;
  }
  panel = document.createElement('div');
  panel.className = 'assistant-activity';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'assistant-activity-header';

  const current = document.createElement('span');
  current.className = 'assistant-activity-current';
  current.textContent = '白泽正在准备调用本机 Claude Code。';
  header.appendChild(current);

  const toggle = document.createElement('span');
  toggle.className = 'assistant-activity-toggle';
  toggle.textContent = '展开';
  header.appendChild(toggle);

  const list = document.createElement('ol');
  list.className = 'assistant-activity-list';
  list.hidden = true;

  header.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.textContent = list.hidden ? '展开' : '收起';
  });

  panel.appendChild(header);
  panel.appendChild(list);
  assistantBody.parentElement.insertBefore(panel, assistantBody);
  return panel;
}

function recordAssistantActivity(assistantBody, event) {
  if (!assistantBody || !event || !state.showServerActivity) {
    return;
  }
  const message = event.message || event.step || '白泽正在处理。';
  state.serverActivityText = message;
  const panel = ensureAssistantActivityPanel(assistantBody);
  if (panel) {
    const current = panel.querySelector('.assistant-activity-current');
    if (current) {
      current.textContent = message;
    }
    const list = panel.querySelector('.assistant-activity-list');
    if (list) {
      const item = document.createElement('li');
      item.className = 'assistant-activity-item';
      const time = document.createElement('span');
      time.className = 'assistant-activity-time';
      time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      item.appendChild(time);
      item.appendChild(document.createTextNode(message));
      list.appendChild(item);
      while (list.children.length > state.assistantActivityLimit) {
        list.removeChild(list.firstElementChild);
      }
    }
  }
  if (state.replyStartedAt) {
    updateReplyTimer();
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function finalizeAssistantActivity(assistantBody) {
  if (!assistantBody) {
    return;
  }
  state.serverActivityText = '';
  const panel = assistantBody.parentElement && assistantBody.parentElement.querySelector('.assistant-activity');
  if (panel) {
    const current = panel.querySelector('.assistant-activity-current');
    if (current) {
      current.textContent = 'Claude Code 执行结束。';
    }
  }
  if (state.replyStartedAt) {
    updateReplyTimer();
  }
}

async function renderActiveConversation() {
  const active = currentConversation();
  elements.activeConversationTitle.textContent = active ? active.title || '新会话' : '白泽';
  elements.messages.replaceChildren();

  if (!active) {
    return;
  }

  const detail = await window.baize.getConversation(active.id);
  for (const message of detail.messages) {
    renderMessage(message);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function loadConversations() {
  state.conversations = await window.baize.listConversations();
  if (state.conversations.length === 0) {
    const conversation = await window.baize.createConversation({ title: '新会话' });
    state.conversations = [conversation];
  }

  state.currentConversationId = state.currentConversationId || state.conversations[0].id;
  renderConversationList();
  await renderActiveConversation();
}

async function selectConversation(conversationId) {
  if (state.sending) {
    return;
  }

  state.currentConversationId = conversationId;
  renderConversationList();
  await renderActiveConversation();
  elements.chatInput.focus();
}

async function createNewConversation() {
  const conversation = await window.baize.createConversation({ title: '新会话' });
  state.currentConversationId = conversation.id;
  await loadConversations();
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function refreshStatus() {
  try {
    await withTimeout(window.baize.health(), 3000, '服务器连接检测超时。');
    setConnectionStatus('服务器已连接', 'ok');
  } catch (error) {
    setConnectionStatus('服务器未连接', 'error');
  }
}

async function loadSettings() {
  refreshStatus();
  try {
    state.clientId = await withTimeout(window.baize.getClientId(), 3000, '客户端 ID 初始化超时。');
  } catch {
    state.clientId = '';
  }
  if (typeof window.baize.getShowServerActivity === 'function') {
    try {
      state.showServerActivity = await withTimeout(window.baize.getShowServerActivity(), 3000, '活动设置读取超时。');
    } catch {
      state.showServerActivity = true;
    }
  }
  await refreshStatus();
}

async function appendLocalMessage(message) {
  const result = await window.baize.appendConversationMessage(state.currentConversationId, message);
  state.conversations = await window.baize.listConversations();
  renderConversationList();
  await renderActiveConversation();
  return result;
}

function timestampFileName(prefix, extension) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${prefix}-${stamp}.${extension}`;
}

function mimeExtension(mimeType) {
  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  if (mimeType === 'image/gif') {
    return 'gif';
  }
  return 'png';
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.slice(index, index + 8192)));
  }
  return btoa(chunks.join(''));
}

async function appendAttachmentUploadResult(result) {
  const attachment = result.attachment || result;
  await appendLocalMessage({
    role: 'assistant',
    text: attachment.analysis.summary,
    meta: 'attachment',
    attachment
  });
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return '';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function showImagePreview(upload) {
  if (!upload.previewUrl) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'image-preview-dialog';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'image-preview-close';
  closeButton.textContent = '×';
  const image = document.createElement('img');
  image.src = upload.previewUrl;
  image.alt = upload.fileName;
  dialog.append(closeButton, image);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
}

function renderPendingUploads() {
  elements.pendingUploadTray.replaceChildren();
  elements.pendingUploadTray.hidden = state.pendingUploads.length === 0;

  for (const upload of state.pendingUploads) {
    const item = document.createElement('div');
    item.className = 'pending-upload-item';

    const icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'pending-upload-icon';
    if (upload.previewUrl) {
      const preview = document.createElement('img');
      preview.src = upload.previewUrl;
      preview.alt = upload.fileName;
      icon.appendChild(preview);
      icon.title = '点击查看大图';
      icon.addEventListener('click', () => showImagePreview(upload));
    } else {
      icon.textContent = upload.mimeType && upload.mimeType.startsWith('image/') ? '图' : '文';
    }
    item.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'pending-upload-info';
    const name = document.createElement('div');
    name.className = 'pending-upload-name';
    name.textContent = upload.fileName;
    const meta = document.createElement('div');
    meta.className = 'pending-upload-meta';
    meta.textContent = formatFileSize(upload.size) || '待上传';
    info.append(name, meta);
    item.appendChild(info);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'pending-upload-remove';
    removeButton.setAttribute('aria-label', `移除 ${upload.fileName}`);
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
      state.pendingUploads = state.pendingUploads.filter((itemUpload) => itemUpload.id !== upload.id);
      renderPendingUploads();
    });
    item.appendChild(removeButton);

    elements.pendingUploadTray.appendChild(item);
  }
}

function addPendingUpload(upload) {
  state.pendingUploads.push({
    id: `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...upload
  });
  renderPendingUploads();
}

async function uploadOnePendingAttachment(upload, requestId) {
  const payload = {
    mimeType: upload.mimeType || '',
    conversationId: state.currentConversationId,
    clientId: state.clientId,
    userId: 'desktop-user',
    requestId
  };
  const result = upload.source === 'file'
    ? await window.baize.uploadAttachmentFile(upload.filePath, payload)
    : await window.baize.uploadAttachmentData({
      ...payload,
      fileName: upload.fileName,
      contentBase64: upload.contentBase64
    });
  const attachment = result.attachment || result;
  return {
    ...attachment,
    source: upload.source || attachment.source || 'unknown',
    fileName: attachment.fileName || upload.fileName || upload.filePath || '',
    mimeType: attachment.mimeType || upload.mimeType || '',
    size: Number.isFinite(attachment.size) ? attachment.size : upload.size,
    localPath: upload.source === 'file' ? upload.filePath : attachment.localPath
  };
}

async function uploadPendingAttachments(uploads, progress, requestId) {
  if (uploads.length === 0) {
    return [];
  }

  let completed = 0;
  const attachments = await Promise.all(uploads.map(async (upload) => {
    const attachment = await uploadOnePendingAttachment(upload, requestId);
    completed += 1;
    if (progress) {
      progress.setCompleted(completed);
    }
    return attachment;
  }));
  await refreshStatus();
  return attachments;
}

function renderUploadProgress(uploads) {
  const article = document.createElement('article');
  article.className = 'message message-assistant';

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = '白泽';
  article.appendChild(label);

  const card = document.createElement('div');
  card.className = 'upload-progress-card';
  article.appendChild(card);

  const title = document.createElement('div');
  title.className = 'upload-progress-title';
  title.textContent = '正在上传附件';
  card.appendChild(title);

  const status = document.createElement('div');
  status.className = 'upload-progress-status';
  card.appendChild(status);

  const track = document.createElement('div');
  track.className = 'upload-progress-track';
  const bar = document.createElement('div');
  bar.className = 'upload-progress-bar';
  track.appendChild(bar);
  card.appendChild(track);

  const startedAt = Date.now();
  let completed = 0;
  const total = uploads.length;

  const render = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    status.textContent = `已等待 ${seconds} 秒，正在处理 ${completed}/${total} 个文件。`;
    bar.style.width = `${total === 0 ? 100 : Math.max(8, Math.round((completed / total) * 100))}%`;
  };

  render();
  const timer = setInterval(render, 1000);
  elements.messages.appendChild(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;

  return {
    setCompleted(value) {
      completed = value;
      render();
    },
    remove() {
      clearInterval(timer);
      article.remove();
    }
  };
}

function clearPendingUploads() {
  for (const upload of state.pendingUploads) {
    if (upload.objectUrl) {
      URL.revokeObjectURL(upload.objectUrl);
    }
  }
  state.pendingUploads = [];
  renderPendingUploads();
}

function formatUserSendText(text, uploads) {
  const uploadLines = uploads.map((upload) => `- ${upload.fileName}`).join('\n');
  if (text !== '' && uploadLines !== '') {
    return `${text}\n\n待上传文件：\n${uploadLines}`;
  }
  if (uploadLines !== '') {
    return `上传文件：\n${uploadLines}`;
  }
  return text;
}

function buildLocalAttachmentContext(attachments) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.fileName || attachment.name || '',
    mime: attachment.mimeType || attachment.mime || '',
    size: attachment.size,
    source: attachment.source || (attachment.localPath ? 'file' : 'upload'),
    localPath: attachment.localPath
  })).filter((attachment) => attachment.id || attachment.name || attachment.localPath);
}

function buildAttachmentChatText(text, attachments) {
  if (attachments.length === 0) {
    return text;
  }

  const contextualAttachments = attachments.filter((attachment) => attachment.type !== 'spreadsheet' && !/\.xlsx?$/i.test(attachment.fileName || ''));
  if (contextualAttachments.length === 0) {
    return text || '请分析我刚上传的附件。';
  }

  const attachmentContext = contextualAttachments.map((attachment, index) => {
    const analysis = attachment.analysis || {};
    const isPlaceholder = analysis.provider === 'local_claude_code_pending';
    return [
      `${index + 1}. ${attachment.fileName || '未命名附件'}`,
      `类型：${attachment.type || attachment.mimeType || 'unknown'}`,
      !isPlaceholder && analysis.summary ? `分析摘要：${analysis.summary}` : '分析摘要：等待本机 Claude Code 读取附件后分析。',
      !isPlaceholder && analysis.extractedText ? `识别文字：${analysis.extractedText}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const userText = text || '请分析我刚上传的附件。';
  return [
    userText,
    '以下是本次发送同时上传到服务器的附件分析结果，请结合这些附件回答：',
    attachmentContext
  ].join('\n\n');
}

async function handleDroppedFiles(files) {
  const droppedFiles = Array.from(files || []);
  if (droppedFiles.length === 0) {
    return;
  }

  for (const file of droppedFiles) {
    const filePath = window.baize.getDroppedFilePath(file);
    if (!filePath) {
      await appendLocalMessage({ role: 'assistant', text: '无法读取拖入文件路径，请从本机文件管理器拖入文件。', meta: 'upload' });
      continue;
    }
    const previewUrl = file.type && file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    addPendingUpload({
      source: 'file',
      filePath,
      fileName: file.name || filePath,
      mimeType: file.type || '',
      size: file.size,
      previewUrl,
      objectUrl: previewUrl,
      label: `上传文件：${file.name || filePath}`
    });
  }
  elements.chatInput.focus();
}

async function handlePastedImages(event) {
  const items = Array.from(event.clipboardData && event.clipboardData.items ? event.clipboardData.items : []);
  const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (imageItems.length === 0) {
    return;
  }

  event.preventDefault();
  const imageFiles = imageItems.map((item) => item.getAsFile()).filter(Boolean);
  if (imageFiles.length === 0) {
    await appendLocalMessage({ role: 'assistant', text: '剪贴板里没有可上传的图片。', meta: 'upload' });
    return;
  }

  for (const file of imageFiles) {
    const mimeType = file.type || 'image/png';
    const fileName = file.name && file.name !== 'image.png'
      ? file.name
      : timestampFileName('clipboard-image', mimeExtension(mimeType));
    const contentBase64 = await blobToBase64(file);
    addPendingUpload({
      source: 'data',
      fileName,
      mimeType,
      size: file.size,
      contentBase64,
      previewUrl: `data:${mimeType};base64,${contentBase64}`,
      label: `粘贴截图：${fileName}`
    });
  }
  elements.chatInput.focus();
}

async function cancelCurrentSend() {
  if (!state.sending || state.cancelling) {
    return;
  }
  state.cancelling = true;
  updateSendButton();
  await window.baize.cancelChatStream();
}

function throwIfCancelled() {
  if (state.cancelling) {
    const error = new Error('已取消本次回答。');
    error.code = 'BAIZE_REQUEST_CANCELLED';
    throw error;
  }
}

async function sendMessage() {
  if (isUpdateRequired()) {
    await appendLocalMessage({ role: 'assistant', text: '当前客户端版本已被服务器要求强制更新，请先下载并重启安装新版。', meta: 'update_required' });
    return;
  }

  const text = elements.chatInput.value.trim();
  const hasPendingUploads = state.pendingUploads.length > 0;
  if ((text === '' && !hasPendingUploads) || state.sending) {
    return;
  }

  if (!state.currentConversationId) {
    await createNewConversation();
  }

  state.sending = true;
  state.cancelling = false;
  state.activeRequestId = window.baize.beginCancellableRequest();
  updateSendButton();
  elements.chatInput.value = '';
  let uploadProgress = null;

  try {
    const uploads = [...state.pendingUploads];
    clearPendingUploads();
    await appendLocalMessage({ role: 'user', text: formatUserSendText(text, uploads) });
    uploadProgress = uploads.length > 0 ? renderUploadProgress(uploads) : null;
    const attachments = await uploadPendingAttachments(uploads, uploadProgress, state.activeRequestId);
    throwIfCancelled();
    if (uploadProgress) {
      uploadProgress.remove();
      uploadProgress = null;
    }
    for (const attachment of attachments) {
      await appendAttachmentUploadResult(attachment);
    }
    throwIfCancelled();

    startReplyTimer();
    const assistantBody = renderStreamingAssistantMessage();
    let streamedReply = '';
    let finalResult = null;
    let claudeCodeOperation = null;
    let jiraOperation = null;
    let jiraSearchSupplement = null;
    let bugAnalysisRun = null;
    let bugAnalysisRunRendered = false;
    let jiraSearchSupplementRendered = false;
    let jiraOperationRendered = false;
    let jiraCommentPreviewCard = null;
    let jiraAuditEvent = null;
    const chatText = buildAttachmentChatText(text, attachments);
    const attachmentIds = attachments.map((attachment) => attachment.id).filter(Boolean);
    const localAttachments = buildLocalAttachmentContext(attachments);

    const result = await window.baize.chatStream({
      text: chatText,
      userId: 'desktop-user',
      conversationId: state.currentConversationId,
      clientId: state.clientId,
      attachmentIds,
      localAttachments
    }, (event) => {
      try { window.baize.debugLog && window.baize.debugLog(`[stream-event] type=${event && event.type} keys=${event ? Object.keys(event).join(',') : ''}`); } catch {}
      if (event.type === 'activity' || event.type === 'status') {
        recordAssistantActivity(assistantBody, event);
      }
      if (event.type === 'delta') {
        streamedReply += event.text || '';
        assistantBody.textContent = streamedReply;
        elements.messages.scrollTop = elements.messages.scrollHeight;
      }
      if (event.type === 'permission_required' && event.permission) {
        claudeCodeOperation = {
          id: event.permission.operationId,
          status: 'awaiting_confirmation',
          conversationId: state.currentConversationId,
          clientId: state.clientId,
          permission: { mode: event.permission.requestedMode || 'write_proposal' },
          risk: { level: event.permission.riskLevel || 'medium' },
          proposal: { summary: null, patch: null, files: [], warnings: [] },
          expiresAt: event.permission.expiresAt
        };
        renderClaudeCodeOperationCard(assistantBody.parentElement, claudeCodeOperation);
      }
      if ((event.type === 'jira_operation_required' || event.type === 'jira_operation_recovery_required') && event.operation) {
        jiraOperation = event.operation;
        renderJiraCreateOperationCard(assistantBody.parentElement, jiraOperation);
        jiraOperationRendered = true;
      }
      if (event.type === 'jira_search_supplement_required' && event.supplement) {
        jiraSearchSupplement = event.supplement;
        renderJiraSearchSupplementCard(assistantBody.parentElement, jiraSearchSupplement);
        jiraSearchSupplementRendered = true;
      }
      if (event.type === 'jira_comment_preview' && (Array.isArray(event.entries) ? event.entries.length > 0 : (event.issueKey && event.body))) {
        jiraCommentPreviewCard = renderJiraCommentPreviewCard(assistantBody.parentElement, event);
      }
      if (event.type === 'jira_comment_result' && jiraCommentPreviewCard) {
        updateJiraCommentPreviewResult(jiraCommentPreviewCard, event);
      }
      if (event.type === 'jira_bug_analysis_started' && event.run) {
        bugAnalysisRun = event.run;
        renderBugAnalysisRunCard(assistantBody.parentElement, bugAnalysisRun);
        bugAnalysisRunRendered = true;
      }
      if (event.type === 'jira_comment_delete_result' && event.issueKey) {
        const parts = [`${event.issueKey}：删除 ${event.deleted || 0} 条`];
        if (event.failed) parts.push(`失败 ${event.failed}`);
        if (event.error) parts.push(`错误：${event.error}`);
        recordAssistantActivity(assistantBody, { step: 'jira_comment_delete_result', message: parts.join('，') });
      }
      if (event.type === 'jira_audit_required' && Array.isArray(event.perIssue)) {
        try {
          jiraAuditEvent = event;
          const card = renderJiraAuditCard(assistantBody.parentElement, event);
          try { window.baize.debugLog && window.baize.debugLog(`[jira_audit_required] rendered=${Boolean(card)} parent=${Boolean(assistantBody.parentElement)} perIssue=${event.perIssue.length} auditId=${event.auditId}`); } catch {}
        } catch (cardError) {
          try { window.baize.debugLog && window.baize.debugLog(`[jira_audit_required] error=${cardError && cardError.stack || cardError}`); } catch {}
        }
      }
      if (event.type === 'done') {
        finalResult = event;
        finalizeAssistantActivity(assistantBody);
      }
    }, state.activeRequestId);

    finalResult = finalResult || result;
    const reply = finalResult && finalResult.reply ? finalResult.reply : streamedReply;
    assistantBody.textContent = reply;
    claudeCodeOperation = finalResult && finalResult.pendingOperation ? finalResult.pendingOperation : claudeCodeOperation;
    jiraOperation = finalResult && finalResult.jiraOperation ? finalResult.jiraOperation : jiraOperation;
    jiraSearchSupplement = finalResult && finalResult.jiraSearchSupplement ? finalResult.jiraSearchSupplement : jiraSearchSupplement;
    bugAnalysisRun = finalResult && finalResult.bugAnalysisRun ? finalResult.bugAnalysisRun : bugAnalysisRun;
    if (bugAnalysisRun && !bugAnalysisRunRendered) {
      renderBugAnalysisRunCard(assistantBody.parentElement, bugAnalysisRun);
    }
    if (jiraOperation && !jiraOperationRendered) {
      renderJiraCreateOperationCard(assistantBody.parentElement, jiraOperation);
    }
    if (jiraSearchSupplement && !jiraSearchSupplementRendered) {
      renderJiraSearchSupplementCard(assistantBody.parentElement, jiraSearchSupplement);
    }

    if (finalResult && finalResult.conversation && finalResult.conversation.title) {
      await window.baize.updateConversation(state.currentConversationId, {
        title: finalResult.conversation.title,
        updatedAt: finalResult.conversation.updatedAt
      });
    }

    await window.baize.appendConversationMessage(state.currentConversationId, {
      role: 'assistant',
      text: reply,
      meta: `provider: ${finalResult && finalResult.provider ? finalResult.provider : 'unknown'}`,
      results: finalResult && finalResult.results ? finalResult.results : [],
      claudeCodeOperation,
      jiraOperation,
      jiraSearchSupplement,
      jiraAudit: jiraAuditEvent,
      bugAnalysisRun
    });
    state.conversations = await window.baize.listConversations();
    renderConversationList();
    await renderActiveConversation();
    await refreshStatus();
  } catch (error) {
    if (uploadProgress) {
      uploadProgress.remove();
    }
    await appendLocalMessage({ role: 'assistant', text: describeError(error), meta: state.cancelling ? 'cancelled' : 'error' });
  } finally {
    stopReplyTimer();
    state.sending = false;
    state.cancelling = false;
    state.activeRequestId = null;
    updateSendButton();
    elements.chatInput.focus();
  }
}

elements.windowMinimize.addEventListener('click', () => window.baize.minimizeWindow());
elements.windowMaximize.addEventListener('click', () => window.baize.toggleMaximizeWindow());
elements.windowClose.addEventListener('click', () => window.baize.closeWindow());

elements.updateAction.addEventListener('click', async () => {
  try {
    if (state.updateState && state.updateState.status === 'downloaded') {
      await window.baize.installUpdate();
      return;
    }
    await window.baize.downloadUpdate();
  } catch (error) {
    renderUpdateState({
      ...(state.updateState || {}),
      status: 'error',
      message: describeError(error)
    });
  }
});

elements.newConversation.addEventListener('click', createNewConversation);
elements.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.sending) {
    cancelCurrentSend();
    return;
  }
  sendMessage();
});
elements.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!state.sending) {
      sendMessage();
    }
  }
});

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.messages.classList.add('drag-over');
});

document.addEventListener('dragleave', (event) => {
  if (event.target === document || event.target === document.body) {
    elements.messages.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.messages.classList.remove('drag-over');
  handleDroppedFiles(event.dataTransfer.files);
});

document.addEventListener('paste', (event) => {
  handlePastedImages(event);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.conversation-context-menu')) {
    hideConversationMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideConversationMenu();
  }
});

async function initializeUpdates() {
  if (!window.baize.getUpdateStatus) {
    return;
  }
  renderUpdateState(await window.baize.getUpdateStatus());
  if (window.baize.onUpdateState) {
    window.baize.onUpdateState(renderUpdateState);
  }
  window.baize.checkForUpdate().catch((error) => {
    renderUpdateState({
      status: 'error',
      message: describeError(error),
      versionStatus: state.updateState && state.updateState.versionStatus
    });
  });
}

async function initialize() {
  await loadSettings();
  await initializeUpdates();
  await loadConversations();
}

initialize();
