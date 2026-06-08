const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
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

const DEFAULT_UNITY_EXE_PATH = 'D:\\Unity-2022.3.61f1\\Unity-2022.3.61f1\\Editor\\Unity.exe';

function createLocalRuntime({ getServerUrl, getClientId, getMachineCode, getClientAccount, chatTransport = {}, getRuntimeConfig, localClaudeCode, imageAnalyzer = analyzeLocalImageAttachment, claudeCodeSessionStore, syncStore, jiraService, spawnImpl = spawn } = {}) {
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
      return await transport.getClientRuntimeStatus(serverUrl, await getClientRuntimeIdentity());
    } catch (error) {
      try {
        return await transport.getClaudeCodeConfig(serverUrl);
      } catch (nestedError) {
        return { enabled: false, unavailable: true };
      }
    }
  }

  async function getClientRuntimeIdentity() {
    return {
      clientId: await getClientId(),
      machineCode: typeof getMachineCode === 'function' ? await getMachineCode() : undefined,
      platform: 'windows'
    };
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

  function readString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
  }

  async function getConfiguredProjectSettings() {
    if (typeof getClientAccount !== 'function') {
      return { workspacePath: '', unityExePath: '', validationCommand: '' };
    }
    const account = await getClientAccount().catch(() => null);
    const svn = account && account.bindings && account.bindings.svn;
    return {
      workspacePath: readString(svn && svn.workspacePath),
      unityExePath: readString(svn && svn.unityExePath) || DEFAULT_UNITY_EXE_PATH,
      validationCommand: readString(svn && svn.validationCommand)
    };
  }

  function runSvnUpdate(workspacePath, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl('svn', ['update', workspacePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        const error = new Error('SVN update 超过 10 分钟，请检查工程目录或 SVN 网络状态。');
        error.code = 'SVN_UPDATE_TIMEOUT';
        reject(error);
      }, 10 * 60 * 1000);
      const cancel = () => {
        if (settled) {
          return;
        }
        child.kill('SIGTERM');
        const error = new Error('已取消 SVN update。');
        error.code = 'BAIZE_REQUEST_CANCELLED';
        reject(error);
      };
      if (signal) {
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener('abort', cancel, { once: true });
      }
      child.stdout && child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr && child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? new Error('本机没有找到 svn 命令，无法执行队列级 SVN update。') : error);
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error((stderr || stdout || `SVN update 失败，退出码 ${code}。`).trim()));
          return;
        }
        resolve({ workspacePath, stdout: stdout.trim(), updatedAt: new Date().toISOString() });
      });
    });
  }

  async function updateProjectWorkspace({ signal, onEvent, plugin = 'jira', action = 'auto_fix_bugs', missingMessage = '未配置 SVN 工程目录，Claude Code 将按 Jira 信息自行定位工程。', startPrefix = '正在队列级更新 SVN 工程目录' } = {}) {
    const projectSettings = await getConfiguredProjectSettings();
    const { workspacePath } = projectSettings;
    if (!workspacePath) {
      emitStatus(onEvent, missingMessage, { plugin, action });
      return projectSettings;
    }
    emitStatus(onEvent, `${startPrefix}：${workspacePath}`, { plugin, action, workspacePath });
    const result = await runSvnUpdate(workspacePath, { signal });
    emitStatus(onEvent, `SVN update 已完成：${workspacePath}`, { plugin, action, workspacePath });
    return { ...projectSettings, ...result };
  }

  async function updateAutoFixWorkspace({ signal, onEvent } = {}) {
    return updateProjectWorkspace({ signal, onEvent });
  }

  async function updateRequirementCompletionWorkspace({ signal, onEvent } = {}) {
    return updateProjectWorkspace({
      signal,
      onEvent,
      plugin: 'engineering',
      action: 'auto_complete_requirement',
      missingMessage: '未配置 SVN 工程目录，无法可靠完成工程级需求；Claude Code 将尝试从当前工作区判断。',
      startPrefix: '正在为需求完成更新 SVN 工程目录'
    });
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

  function truncateText(value, limit = 2000) {
    const text = String(value || '').trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  }

  function checkCancelled(signal) {
    if (signal && signal.aborted) {
      const error = new Error('已取消本次自动修 Bug 队列。');
      error.code = 'BAIZE_REQUEST_CANCELLED';
      throw error;
    }
  }

  function createAutoFixProgress() {
    const startedAtMs = Date.now();
    return { startedAtMs, lastEventAtMs: startedAtMs, lastStatus: '', lastDelta: '', lastReply: '', logs: [], timings: [] };
  }

  function recordAutoFixProgress(progress, event) {
    if (!progress || !event) {
      return null;
    }
    const now = Date.now();
    const elapsedMs = now - progress.startedAtMs;
    const stepMs = now - progress.lastEventAtMs;
    progress.lastEventAtMs = now;
    const timing = {
      type: event.type || 'unknown',
      message: truncateText(event.message || event.text || event.reply || '', 300),
      elapsedMs,
      stepMs,
      elapsedText: formatDuration(elapsedMs),
      stepText: formatDuration(stepMs),
      at: new Date(now).toISOString()
    };
    if (event.type === 'status' && event.message) {
      progress.lastStatus = event.message;
      progress.logs.push(`[总耗时 ${timing.elapsedText}，上一步 ${timing.stepText}] ${event.message}`);
    } else if (event.type === 'delta' && event.text) {
      progress.lastDelta = `${progress.lastDelta || ''}${event.text}`.slice(-2000);
      progress.logs.push(`[总耗时 ${timing.elapsedText}，上一步 ${timing.stepText}] ${event.text}`);
    } else if (event.type === 'done' && event.reply) {
      progress.lastReply = event.reply;
      progress.logs.push(`[总耗时 ${timing.elapsedText}，上一步 ${timing.stepText}] ${event.reply}`);
    }
    progress.timings.push(timing);
    while (progress.logs.length > 40) {
      progress.logs.shift();
    }
    while (progress.timings.length > 80) {
      progress.timings.shift();
    }
    return timing;
  }

  function summarizeAutoFixProgress(progress) {
    const elapsedMs = progress && progress.startedAtMs ? Date.now() - progress.startedAtMs : 0;
    const summary = {
      startedAt: progress && progress.startedAtMs ? new Date(progress.startedAtMs).toISOString() : '',
      elapsedMs,
      elapsedText: formatDuration(elapsedMs),
      lastStatus: progress && progress.lastStatus ? truncateText(progress.lastStatus, 500) : '',
      lastDelta: progress && progress.lastDelta ? truncateText(progress.lastDelta, 1000) : '',
      lastReply: progress && progress.lastReply ? truncateText(progress.lastReply, 1000) : '',
      logs: progress && Array.isArray(progress.logs) ? progress.logs.slice(-12).map((item) => truncateText(item, 500)) : [],
      timings: progress && Array.isArray(progress.timings) ? progress.timings.slice(-20) : []
    };
    return summary.lastStatus || summary.lastDelta || summary.lastReply || summary.logs.length > 0 || summary.timings.length > 0 ? summary : null;
  }

  function safeLogName(value) {
    return String(value || 'auto-fix')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'auto-fix';
  }

  function markdownText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
  }

  function markdownList(value) {
    return markdownText(value).split('\n').filter((line) => line.trim() !== '').map((line) => `  - ${line}`).join('\n');
  }

  async function writeAutoFixChangeLog(queue = {}, result = {}, workspaceUpdate = {}) {
    const workspacePath = workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : process.cwd();
    const logDir = path.join(workspacePath, 'baize', 'runtime', 'auto-fix-logs');
    const now = new Date().toISOString();
    const issuePart = Array.isArray(result.items) && result.items.length > 0
      ? result.items.map((item) => safeLogName(item.issueKey)).join('-')
      : safeLogName(queue.id);
    const filePath = path.join(logDir, `${now.replace(/[:.]/g, '-')}-${issuePart}.md`);
    const lines = [
      '# 自动修 BUG 修改日志',
      '',
      `- 生成时间：${now}`,
      `- 队列 ID：${queue.id || '-'}`,
      `- 会话 ID：${queue.conversationId || '-'}`,
      `- Jira 查询：${queue.jql || '-'}`,
      `- 工程目录：${workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : '-'}`,
      `- SVN 更新时间：${workspaceUpdate && workspaceUpdate.updatedAt ? workspaceUpdate.updatedAt : '-'}`,
      `- Unity.exe：${workspaceUpdate && workspaceUpdate.unityExePath ? workspaceUpdate.unityExePath : '-'}`,
      `- 验证命令：${workspaceUpdate && workspaceUpdate.validationCommand ? workspaceUpdate.validationCommand : '-'}`,
      `- 总数：${result.queued || 0}`,
      `- 成功：${result.completed || 0}`,
      `- 失败：${result.failed || 0}`,
      result.stoppedReason ? `- 停止原因：${result.stoppedReason}` : '',
      '',
      '## BUG 明细'
    ].filter(Boolean);
    for (const item of result.items || []) {
      const progress = item.progress || {};
      lines.push(
        '',
        `### ${item.issueKey || '未知 BUG'} ${item.summary || ''}`.trim(),
        '',
        `- 状态：${item.status || '-'}`,
        `- 总耗时：${progress.elapsedText || '-'}`,
        item.error ? `- 错误：${item.error}` : '',
        progress.lastStatus ? `- 最后状态：${progress.lastStatus}` : '',
        '',
        '#### Claude Code 回复',
        '',
        markdownText(item.reply || progress.lastReply || '无。'),
        '',
        '#### 最近进度',
        '',
        Array.isArray(progress.logs) && progress.logs.length > 0 ? markdownList(progress.logs.slice(-12).join('\n')) : '无。',
        '',
        '#### 最近耗时',
        '',
        Array.isArray(progress.timings) && progress.timings.length > 0
          ? progress.timings.slice(-20).map((timing) => `- [总耗时 ${timing.elapsedText || '-'}｜上一步 ${timing.stepText || '-'}] ${timing.message || timing.type || ''}`).join('\n')
          : '无。'
      );
    }
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(filePath, `${lines.filter((line) => line !== undefined).join('\n')}\n`, 'utf8');
    return { filePath, generatedAt: now };
  }

  function buildJiraBugSupplementContext(issue = {}) {
    const comments = Array.isArray(issue.comments) ? issue.comments.filter((comment) => comment && comment.body).slice(-8) : [];
    const attachments = Array.isArray(issue.attachments) ? issue.attachments.filter((attachment) => attachment && attachment.filename).slice(0, 12) : [];
    return [
      'Jira 评论补充：',
      comments.length > 0
        ? comments.map((comment, index) => `${index + 1}. ${comment.author || '未知'} ${comment.updated || comment.created || ''}\n${comment.body}`).join('\n\n')
        : '无。',
      '',
      'Jira 附件元信息：',
      attachments.length > 0
        ? attachments.map((attachment, index) => `${index + 1}. ${attachment.filename}（${attachment.mimeType || '未知类型'}，${attachment.size || 0} bytes，${attachment.created || ''}）`).join('\n')
        : '无。'
    ].join('\n');
  }

  function formatRequirementCompletionContext(run = {}, workspaceUpdate = {}) {
    const workspacePath = workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : '';
    const unityExePath = workspaceUpdate && workspaceUpdate.unityExePath ? workspaceUpdate.unityExePath : '';
    const validationCommand = workspaceUpdate && workspaceUpdate.validationCommand ? workspaceUpdate.validationCommand : '';
    return [
      `需求标题：${run.title || '未命名需求'}`,
      `需求来源：${run.sourceType || 'manual'}`,
      `用户原始指令：${run.originalText || run.requirementText || ''}`,
      `需求内容：${run.requirementText || run.originalText || ''}`,
      workspacePath ? `已配置工程目录：${workspacePath}` : '已配置工程目录：未配置',
      unityExePath ? `固定 Unity.exe 路径：${unityExePath}` : '固定 Unity.exe 路径：未配置',
      validationCommand ? `固定验证命令：${validationCommand}` : '固定验证命令：未配置',
      workspaceUpdate && workspaceUpdate.updatedAt ? `SVN update 完成时间：${workspaceUpdate.updatedAt}` : 'SVN update 完成时间：未执行',
      run.issueKey ? `关联 Jira：${run.issueKey}` : '关联 Jira：无',
      Array.isArray(run.attachments) && run.attachments.length > 0 ? `附件：${JSON.stringify(run.attachments)}` : '附件：无'
    ].join('\n');
  }

  function buildRequirementPlanPrompt({ run, workspaceUpdate }) {
    return [
      '你是白泽客户端本机 Claude Code 需求工程级完成规划员。',
      '这是只读规划阶段，不允许修改任何文件，不允许执行会改变工程状态的命令。',
      '必须基于当前工程代码、配置、资源和需求内容给出工程级执行计划；如果无法读取工程或缺少关键需求信息，必须明确说明无法继续。',
      '请输出中文，包含：需求理解、工程依据来源、实施步骤、预计修改文件或模块、验证方案、风险和需要用户确认的问题。',
      '不要输出 clientOperations，不要声称已经完成需求。',
      '',
      formatRequirementCompletionContext(run, workspaceUpdate)
    ].join('\n');
  }

  function buildRequirementExecutionPrompt({ run, workspaceUpdate }) {
    return [
      '你是白泽客户端本机 Claude Code 需求工程级执行员。',
      '用户已经确认执行计划，现在允许你修改工程文件。',
      '只能实现已确认需求，不要扩大范围；不要提交代码、不要 push、不要写 Jira，除非用户之后单独确认。',
      '必须先基于当前工程状态复核计划，再修改代码、配置或资源。',
      '如果提供固定验证命令，验证阶段必须优先运行；否则运行最小必要测试或构建验证。',
      '如果无法读取工程、无法验证或需求信息不足，必须停止并说明原因，不要伪装成功。',
      '输出中文完成报告，包含工程依据来源、修改文件、验证结果、未完成风险。',
      '',
      '用户确认的执行计划：',
      run.plan && run.plan.text ? run.plan.text : '无计划文本。',
      '',
      formatRequirementCompletionContext(run, workspaceUpdate)
    ].join('\n');
  }

  function buildAutoFixBugPrompt({ issue, index, total, originalText, workspaceUpdate }) {
    const workspacePath = workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : '';
    const unityExePath = workspaceUpdate && workspaceUpdate.unityExePath ? workspaceUpdate.unityExePath : '';
    const validationCommand = workspaceUpdate && workspaceUpdate.validationCommand ? workspaceUpdate.validationCommand : '';
    return [
      '你是白泽客户端本机 Claude Code Jira Bug 自动修复执行员。',
      '请只处理下面这一个 Jira Bug；完成或失败后不要继续处理其他 Bug，外层客户端会按队列调度下一个。',
      '你必须先完成 Jira Bug 工程级分析前置条件：队列级 SVN update 已由客户端在执行本 Bug 前完成；如果下面提供了已配置工程目录，必须直接从该目录开始分析，不要重新全仓探索 SVN 或 Unity 工程入口。',
      '如果当前环境无法读取已配置工程目录，或找不到与该 Bug 对应的工程依据，必须停止本 Bug 修复并明确说明无法完成工程级分析；不要伪装成已分析或已修复。',
      '在满足工程依据后，完整执行：工程级分析、定位原因、生成修复方案、修改工程代码、运行必要测试/构建/验证。',
      '如果下面提供了固定 Unity.exe 路径或固定验证命令，验证阶段必须优先使用这些配置；不要再自行全盘查找 Unity.exe、sln、csproj 或其它验证入口。',
      '搜索必须先基于 Jira 标题、描述、评论和附件元信息提取 1-2 个最强入口；只有当前入口的代码、配置或日志证据指向其它系统时，才扩大搜索范围。',
      '只修改与本 Bug 直接相关的工程文件；不要写 Jira 评论，不要创建 Jira 单，不要输出 clientOperations。',
      '输出中文修复总结，包含工程依据来源、修改文件、验证结果、未完成风险。',
      '',
      `队列进度：${index + 1}/${total}`,
      `用户原始指令：${originalText || ''}`,
      workspacePath ? `已配置工程目录：${workspacePath}` : '已配置工程目录：未配置',
      unityExePath ? `固定 Unity.exe 路径：${unityExePath}` : '固定 Unity.exe 路径：未配置',
      validationCommand ? `固定验证命令：${validationCommand}` : '固定验证命令：未配置',
      workspaceUpdate && workspaceUpdate.updatedAt ? `队列级 SVN update 完成时间：${workspaceUpdate.updatedAt}` : '队列级 SVN update 完成时间：未执行',
      `Jira Key：${issue.key || ''}`,
      `标题：${issue.summary || ''}`,
      `状态：${issue.status || ''}`,
      `状态分类：${issue.statusCategory || ''}`,
      `项目：${issue.project || ''}`,
      `优先级：${issue.priority || ''}`,
      `负责人：${issue.assignee || ''}`,
      `报告人：${issue.reporter || ''}`,
      `标签：${Array.isArray(issue.labels) ? issue.labels.join(', ') : ''}`,
      `创建时间：${issue.created || ''}`,
      `更新时间：${issue.updated || ''}`,
      '',
      '描述：',
      issue.description || '无描述。',
      '',
      buildJiraBugSupplementContext(issue)
    ].join('\n');
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

  function normalizeIssueKeys(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return value.split(/[，,、；;\s]+/).map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }

  function selectAutoFixIssues(issues = [], input = {}) {
    const requestedKeys = normalizeIssueKeys(input.issueKeys || input.selectedIssueKeys || input.keys || input.issueKey);
    if (requestedKeys.length === 0) {
      return issues;
    }
    const requested = new Set(requestedKeys.map((key) => key.toUpperCase()));
    return issues.filter((issue) => requested.has(String(issue.key || '').toUpperCase()));
  }

  async function buildAutoFixBugQueue(chatInput, input = {}, { signal, onEvent } = {}) {
    if (!jiraService || typeof jiraService.searchUnstartedBugs !== 'function') {
      return { ok: false, code: 'LOCAL_JIRA_SERVICE_UNAVAILABLE', message: '本机 Jira 查询服务不可用，请检查客户端 Jira 绑定。' };
    }
    checkCancelled(signal);
    emitStatus(onEvent, '白泽正在用当前客户端绑定的 Jira 账号拉取未开始 Bug 队列。', { plugin: 'jira', action: 'auto_fix_bugs' });
    const queue = await jiraService.searchUnstartedBugs(input);
    const issues = Array.isArray(queue.issues) ? queue.issues : [];
    const selectedIssues = selectAutoFixIssues(issues, input);
    return {
      id: `auto-fix-bugs-${crypto.randomUUID()}`,
      status: issues.length === 0 ? 'empty' : 'awaiting_confirmation',
      jql: queue.jql,
      total: queue.total || issues.length,
      queued: issues.length,
      selectedCount: selectedIssues.length,
      issueKeys: selectedIssues.map((issue) => issue.key).filter(Boolean),
      issues,
      createdAt: new Date().toISOString(),
      clientId: chatInput.clientId,
      conversationId: chatInput.conversationId,
      userId: chatInput.userId || 'desktop-user',
      originalText: chatInput.text || '',
      stoppedReason: issues.length === 0 ? '未找到当前 Jira 账号下未开始阶段的 Bug。' : null,
      input: {
        maxResults: input.maxResults,
        continueOnFailure: input.continueOnFailure === true
      }
    };
  }

  async function executeAutoFixBugQueue(queue = {}, input = {}, { signal, onEvent, localClaudeCodeEnv } = {}) {
    const selectedIssues = selectAutoFixIssues(Array.isArray(queue.issues) ? queue.issues : [], input);
    if (selectedIssues.length === 0) {
      return {
        ok: false,
        status: 'failed',
        jql: queue.jql,
        total: queue.total || 0,
        queued: 0,
        completed: 0,
        failed: 0,
        stoppedReason: '没有选择要自动修改的 Bug。',
        items: []
      };
    }

    let workspaceUpdate;
    try {
      workspaceUpdate = await updateAutoFixWorkspace({ signal, onEvent });
    } catch (error) {
      const result = {
        ok: false,
        status: 'failed',
        jql: queue.jql,
        total: queue.total || selectedIssues.length,
        queued: selectedIssues.length,
        completed: 0,
        failed: selectedIssues.length,
        stoppedReason: error.message || '队列级 SVN update 失败。',
        items: selectedIssues.map((issue) => ({ issueKey: issue.key, summary: issue.summary || '', status: 'failed', error: error.message || '队列级 SVN update 失败。' }))
      };
      try {
        result.changeLog = await writeAutoFixChangeLog(queue, result, {});
      } catch (logError) {
        result.changeLog = { error: logError.message || '自动修 BUG 修改日志写入失败。' };
      }
      return result;
    }

    const items = [];
    const continueOnFailure = input.continueOnFailure === true || queue.input && queue.input.continueOnFailure === true;
    for (let index = 0; index < selectedIssues.length; index += 1) {
      checkCancelled(signal);
      const issue = selectedIssues[index];
      const progress = createAutoFixProgress();
      emitStatus(onEvent, `白泽正在修复第 ${index + 1}/${selectedIssues.length} 个 Bug：${issue.key} ${issue.summary || ''}`.trim(), { plugin: 'jira', action: 'auto_fix_bugs', issueKey: issue.key });
      try {
        const result = await localChat.sendStream({
          text: buildAutoFixBugPrompt({ issue, index, total: selectedIssues.length, originalText: queue.originalText || input.originalText, workspaceUpdate }),
          originalText: queue.originalText || input.originalText || '',
          userId: queue.userId || input.userId || 'desktop-user',
          conversationId: `${queue.conversationId || 'auto-fix-bugs'}:${issue.key}`,
          clientId: queue.clientId || input.clientId
        }, {
          signal,
          onEvent: (event) => {
            const timing = recordAutoFixProgress(progress, event);
            if (typeof onEvent === 'function' && event) {
              onEvent({ ...event, timing, plugin: 'jira', action: 'auto_fix_bugs', issueKey: issue.key });
            }
          },
          localClaudeCodeEnv,
          mode: 'auto_bug_fix_execution',
          cwd: workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : undefined
        });
        items.push({
          issueKey: issue.key,
          summary: issue.summary || '',
          status: 'completed',
          reply: truncateText(result && result.reply),
          progress: summarizeAutoFixProgress(progress)
        });
        emitStatus(onEvent, `Bug ${issue.key} 已完成本机 Claude Code 修复。`, { plugin: 'jira', action: 'auto_fix_bugs', issueKey: issue.key });
      } catch (error) {
        items.push({
          issueKey: issue.key,
          summary: issue.summary || '',
          status: 'failed',
          error: error.message || '本机 Claude Code 修复失败。',
          progress: summarizeAutoFixProgress(progress)
        });
        emitStatus(onEvent, `Bug ${issue.key} 修复失败：${error.message || '未知错误'}`, { plugin: 'jira', action: 'auto_fix_bugs', issueKey: issue.key });
        if (!continueOnFailure) {
          break;
        }
      }
    }

    const completed = items.filter((item) => item.status === 'completed').length;
    const failed = items.filter((item) => item.status === 'failed').length;
    const result = {
      ok: failed === 0,
      status: failed === 0 ? 'completed' : 'failed',
      jql: queue.jql,
      total: queue.total || selectedIssues.length,
      queued: selectedIssues.length,
      completed,
      failed,
      stoppedReason: failed > 0 && !continueOnFailure ? '当前 Bug 修复失败，已停止后续队列，避免在未知工程状态下继续修改。' : null,
      items
    };
    try {
      result.changeLog = await writeAutoFixChangeLog(queue, result, workspaceUpdate || {});
    } catch (error) {
      result.changeLog = { error: error.message || '自动修 BUG 修改日志写入失败。' };
    }
    return result;
  }

  async function runAutoFixBugs(chatInput, input = {}, { signal, onEvent } = {}) {
    return buildAutoFixBugQueue(chatInput, input, { signal, onEvent });
  }

  function buildRequirementCompletionRun(chatInput, input = {}) {
    const requirementText = readString(input.requirementText) || readString(input.text) || readString(chatInput.text);
    const title = readString(input.title) || requirementText.slice(0, 60) || '工程需求完成';
    return {
      id: `requirement-completion-${crypto.randomUUID()}`,
      status: requirementText ? 'awaiting_plan' : 'failed',
      title,
      sourceType: readString(input.sourceType) || (input.issueKey ? 'jira_issue' : 'manual'),
      issueKey: readString(input.issueKey),
      requirementText,
      originalText: chatInput.text || requirementText,
      attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 20) : [],
      createdAt: new Date().toISOString(),
      clientId: chatInput.clientId,
      conversationId: chatInput.conversationId,
      userId: chatInput.userId || 'desktop-user',
      plan: null,
      executionResult: null,
      stoppedReason: requirementText ? null : '需求内容为空，无法生成工程级完成计划。'
    };
  }

  async function generateRequirementCompletionPlan(run = {}, input = {}, { signal, onEvent, localClaudeCodeEnv } = {}) {
    let workspaceUpdate;
    try {
      workspaceUpdate = await updateRequirementCompletionWorkspace({ signal, onEvent });
    } catch (error) {
      return {
        ...run,
        status: 'failed',
        stoppedReason: error.message || '需求完成 SVN update 失败。',
        plan: null
      };
    }
    const progress = createAutoFixProgress();
    emitStatus(onEvent, '白泽正在生成需求工程级执行计划。', { plugin: 'engineering', action: 'auto_complete_requirement', runId: run.id });
    try {
      const result = await localChat.sendStream({
        text: buildRequirementPlanPrompt({ run, workspaceUpdate }),
        originalText: run.originalText || run.requirementText || '',
        userId: run.userId || input.userId || 'desktop-user',
        conversationId: `${run.conversationId || 'requirement-completion'}:plan`,
        clientId: run.clientId || input.clientId
      }, {
        signal,
        onEvent: (event) => {
          const timing = recordAutoFixProgress(progress, event);
          if (typeof onEvent === 'function' && event) {
            onEvent({ ...event, timing, plugin: 'engineering', action: 'auto_complete_requirement', phase: 'plan', runId: run.id });
          }
        },
        localClaudeCodeEnv,
        mode: 'requirement_completion_plan',
        cwd: workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : undefined
      });
      return {
        ...run,
        status: 'awaiting_execution_confirmation',
        plan: {
          status: 'completed',
          text: result && result.reply ? result.reply : '',
          generatedAt: new Date().toISOString(),
          progress: summarizeAutoFixProgress(progress),
          workspaceUpdate
        },
        stoppedReason: null
      };
    } catch (error) {
      return {
        ...run,
        status: 'failed',
        stoppedReason: error.message || '需求工程级计划生成失败。',
        plan: {
          status: 'failed',
          error: error.message || '需求工程级计划生成失败。',
          progress: summarizeAutoFixProgress(progress)
        }
      };
    }
  }

  async function executeRequirementCompletionRun(run = {}, input = {}, { signal, onEvent, localClaudeCodeEnv } = {}) {
    if (!run.plan || !run.plan.text) {
      return { ...run, status: 'failed', stoppedReason: '缺少已确认的需求执行计划。' };
    }
    const workspaceUpdate = run.plan.workspaceUpdate || await updateRequirementCompletionWorkspace({ signal, onEvent });
    const progress = createAutoFixProgress();
    emitStatus(onEvent, '白泽正在按已确认计划执行需求工程修改。', { plugin: 'engineering', action: 'auto_complete_requirement', phase: 'execute', runId: run.id });
    try {
      const result = await localChat.sendStream({
        text: buildRequirementExecutionPrompt({ run, workspaceUpdate }),
        originalText: run.originalText || run.requirementText || '',
        userId: run.userId || input.userId || 'desktop-user',
        conversationId: `${run.conversationId || 'requirement-completion'}:execute`,
        clientId: run.clientId || input.clientId
      }, {
        signal,
        onEvent: (event) => {
          const timing = recordAutoFixProgress(progress, event);
          if (typeof onEvent === 'function' && event) {
            onEvent({ ...event, timing, plugin: 'engineering', action: 'auto_complete_requirement', phase: 'execute', runId: run.id });
          }
        },
        localClaudeCodeEnv,
        mode: 'requirement_completion_execution',
        cwd: workspaceUpdate && workspaceUpdate.workspacePath ? workspaceUpdate.workspacePath : undefined
      });
      const executionResult = {
        ok: true,
        status: 'completed',
        reply: truncateText(result && result.reply, 12000),
        progress: summarizeAutoFixProgress(progress),
        finishedAt: new Date().toISOString()
      };
      return {
        ...run,
        status: 'completed',
        executionResult,
        stoppedReason: null
      };
    } catch (error) {
      return {
        ...run,
        status: 'failed',
        executionResult: {
          ok: false,
          status: 'failed',
          error: error.message || '需求工程执行失败。',
          progress: summarizeAutoFixProgress(progress),
          finishedAt: new Date().toISOString()
        },
        stoppedReason: error.message || '需求工程执行失败。'
      };
    }
  }

  async function confirmRequirementCompletionRun(run = {}, input = {}, { signal, onEvent } = {}) {
    const serverUrl = await getServerUrl();
    const config = await readRuntimeConfig(serverUrl);
    if (!shouldUseLocalClaudeCode(config)) {
      throw new Error('本机 Claude Code 未启用，无法执行需求工程完成流程。');
    }
    const nextInput = { ...input, clientId: input.clientId || await getClientId() };
    if (input.phase === 'execute') {
      return executeRequirementCompletionRun(run, nextInput, { signal, onEvent, localClaudeCodeEnv: getLocalClaudeCodeEnv(config) });
    }
    return generateRequirementCompletionPlan(run, nextInput, { signal, onEvent, localClaudeCodeEnv: getLocalClaudeCodeEnv(config) });
  }

  async function executeClientOperation(serverUrl, chatInput, operation = {}, { signal, onEvent, confirmedJiraOperationId, localClaudeCodeEnv } = {}) {
    const jiraAllowedActions = ['search_issue', 'auto_fix_bugs', 'create_issue', 'get_project', 'get_create_meta', 'search_user', 'create_confirmed_issue'];
    if (operation.plugin !== 'jira' && operation.plugin !== 'engineering') {
      return { ok: false, code: 'CLIENT_PLUGIN_ACTION_UNSUPPORTED', message: '当前客户端不支持这个插件桥操作。' };
    }
    if (operation.plugin === 'jira' && !jiraAllowedActions.includes(operation.action)) {
      return { ok: false, code: 'CLIENT_PLUGIN_ACTION_UNSUPPORTED', message: '当前客户端不支持这个 Jira 插件桥操作。' };
    }
    if (operation.plugin === 'engineering' && operation.action !== 'auto_complete_requirement') {
      return { ok: false, code: 'CLIENT_PLUGIN_ACTION_UNSUPPORTED', message: '当前客户端不支持这个工程插件桥操作。' };
    }
    try {
      const input = operation.input && typeof operation.input === 'object' && !Array.isArray(operation.input) ? operation.input : {};
      if (operation.plugin === 'engineering' && operation.action === 'auto_complete_requirement') {
        const result = buildRequirementCompletionRun(chatInput, input);
        if (typeof onEvent === 'function' && result && result.status === 'awaiting_plan') {
          onEvent({ type: 'requirement_completion_required', message: '白泽：已生成需求工程完成卡，请先生成并确认执行计划。', run: result });
        }
        return { ok: result.status !== 'failed', plugin: 'engineering', action: operation.action, id: operation.id, result, requirementCompletionRun: result };
      }
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
      if (operation.action === 'auto_fix_bugs') {
        const result = await runAutoFixBugs(chatInput, input, { signal, onEvent, localClaudeCodeEnv });
        if (typeof onEvent === 'function' && result && result.status === 'awaiting_confirmation') {
          onEvent({ type: 'auto_fix_bug_queue_required', message: '白泽：已梳理出可自动修改的 Jira BUG 队列，请确认要修改哪些 BUG。', queue: result });
        }
        return { ok: result.ok !== false, plugin: 'jira', action: operation.action, id: operation.id, result, autoFixBugQueue: result };
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
        executeClientOperation: (operation) => executeClientOperation(serverUrl, chatInput, operation, {
          ...options,
          localClaudeCodeEnv: getLocalClaudeCodeEnv(config)
        })
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
        executeClientOperation: (operation) => executeClientOperation(serverUrl, chatInput, operation, {
          signal,
          onEvent,
          localClaudeCodeEnv: getLocalClaudeCodeEnv(config)
        })
      });
      await syncLocalEvents(serverUrl, chatInput, result, onEvent);
      return result;
    }
    return transport.sendChatStream(serverUrl, stripLocalOnlyChatInput(chatInput), { signal, onEvent });
  }

  async function confirmAutoFixBugQueue(queue = {}, input = {}, { signal, onEvent } = {}) {
    const serverUrl = await getServerUrl();
    const config = await readRuntimeConfig(serverUrl);
    if (!shouldUseLocalClaudeCode(config)) {
      throw new Error('本机 Claude Code 未启用，无法执行自动修 Bug 队列。');
    }
    emitStatus(onEvent, '已确认自动修 Bug 队列，正在启动本机 Claude Code。', { plugin: 'jira', action: 'auto_fix_bugs' });
    return executeAutoFixBugQueue(queue, {
      ...input,
      clientId: input.clientId || await getClientId()
    }, {
      signal,
      onEvent,
      localClaudeCodeEnv: getLocalClaudeCodeEnv(config)
    });
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
    const [runtime, plugins, account] = await Promise.all([
      readRuntimeConfig(serverUrl),
      transport.getPluginUpdates(serverUrl).catch(() => ({ enabled: false, plugins: [] })),
      typeof getClientAccount === 'function' ? getClientAccount().catch(() => null) : null
    ]);
    return { clientId, machineCode: account && account.machineCode, account, runtime: redactRuntimeConfig(runtime), plugins };
  }

  return {
    handleChat,
    handleChatStream,
    confirmAutoFixBugQueue,
    confirmRequirementCompletionRun,
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
