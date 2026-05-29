const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function packagedClaudeCodeCandidates() {
  const appRoot = path.join(__dirname, '..', '..');
  const resourceRoots = process.resourcesPath
    ? [path.join(process.resourcesPath, 'app.asar.unpacked')]
    : [appRoot];
  return resourceRoots.flatMap((root) => [
    path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe'),
    path.join(root, 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe')
  ]);
}

function readEnvMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => typeof key === 'string' && key.trim() !== '' && typeof item === 'string' && item.trim() !== '')
    .map(([key, item]) => [key.trim(), item.trim()]));
}

function redactActivityText(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]')
    .replace(/(token|api[_-]?key|authorization|cookie|password)\s*[:=]\s*[^\s,;]+/ig, '$1=[已隐藏]')
    .slice(0, 240);
}

function shortPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return '';
  }
  return path.basename(value.trim()) || value.trim();
}

function formatToolUseStatus(block) {
  const name = block && typeof block.name === 'string' ? block.name : '工具';
  const input = block && block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
  if (name === 'Read') {
    return `Claude Code 正在读取文件：${shortPath(input.file_path) || '未命名文件'}`;
  }
  if (name === 'Grep') {
    return `Claude Code 正在搜索内容：${redactActivityText(input.pattern || '') || '未提供关键词'}`;
  }
  if (name === 'Glob') {
    return `Claude Code 正在匹配文件：${redactActivityText(input.pattern || '') || '未提供规则'}`;
  }
  if (name === 'Bash') {
    return `Claude Code 正在运行命令：${redactActivityText(input.command || '') || '命令'}`;
  }
  if (name === 'Edit' || name === 'Write') {
    return `Claude Code 正在准备修改文件：${shortPath(input.file_path) || '未命名文件'}`;
  }
  return `Claude Code 正在调用工具：${name}`;
}

function resolveClaudeCodeCommand(command = process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND || 'claude') {
  const configuredCommand = process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND;
  if (configuredCommand || command !== 'claude') {
    return command;
  }
  const candidates = [
    ...packagedClaudeCodeCandidates(),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.exe')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || command;
}

function createLocalClaudeCodeRunner({ spawnImpl = spawn, command = process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND || 'claude', timeoutMs = 300000 } = {}) {
  return function runLocalClaudeCode({ prompt, signal, onEvent, streamJson = false, resumeSessionId, env, restrictTools = false } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        const error = new Error('请输入要发送给 Claude Code 的内容。');
        error.code = 'LOCAL_CLAUDE_CODE_PROMPT_REQUIRED';
        reject(error);
        return;
      }

      const args = [
        '--print',
        '--output-format',
        streamJson ? 'stream-json' : 'text',
        '--permission-mode',
        'bypassPermissions',
        '--tools',
        restrictTools ? 'Read,Grep,Glob,Bash,Edit,Write' : 'default',
        '--verbose',
        '--include-partial-messages'
      ];
      if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
      }
      const resolvedCommand = resolveClaudeCodeCommand(command);
      const childEnv = {
        ...process.env,
        ...readEnvMap(env),
        PATH: [
          process.env.PATH || '',
          process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : ''
        ].filter(Boolean).join(path.delimiter)
      };
      const child = spawnImpl(resolvedCommand, args, {
        env: childEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (child.stdin && typeof child.stdin.end === 'function') {
        child.stdin.end(prompt);
      }
      let stdout = '';
      let stderr = '';
      let streamBuffer = '';
      let streamedText = '';
      let finalResult = '';
      let sessionId = resumeSessionId || '';
      let settled = false;

      function finishWithError(error) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }

      function cancel() {
        if (settled) {
          return;
        }
        child.kill('SIGTERM');
        const error = new Error('已取消本次回答。');
        error.code = 'BAIZE_REQUEST_CANCELLED';
        finishWithError(error);
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        const error = new Error('本机 Claude Code 处理超时，请稍后重试。');
        error.code = 'LOCAL_CLAUDE_CODE_TIMEOUT';
        finishWithError(error);
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener('abort', cancel, { once: true });
      }

      function emitClaudeCodeStreamEvent(line) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          return;
        }
        if (parsed.session_id) {
          sessionId = parsed.session_id;
        }
        if (parsed.type === 'system' && parsed.subtype === 'init') {
          onEvent && onEvent({ type: 'status', message: `本机 Claude Code 已启动，会话 ${parsed.session_id || sessionId || ''}`.trim() });
          return;
        }
        if (parsed.type === 'system' && parsed.subtype === 'status' && parsed.status) {
          onEvent && onEvent({ type: 'status', message: `Claude Code 状态：${parsed.status}` });
          return;
        }
        if (parsed.type === 'stream_event' && parsed.event && parsed.event.type === 'content_block_delta') {
          const text = parsed.event.delta && parsed.event.delta.text;
          if (text) {
            streamedText += text;
            onEvent && onEvent({ type: 'delta', text });
          }
          return;
        }
        if (parsed.type === 'assistant' && parsed.message && Array.isArray(parsed.message.content)) {
          const textBlocks = [];
          for (const block of parsed.message.content) {
            if (!block || typeof block !== 'object') {
              continue;
            }
            if (block.type === 'text') {
              textBlocks.push(block.text || '');
            }
            if (block.type === 'tool_use') {
              onEvent && onEvent({ type: 'status', message: formatToolUseStatus(block) });
            }
          }
          finalResult = textBlocks.join('').trim() || finalResult;
          return;
        }
        if (parsed.type === 'user' && parsed.message && Array.isArray(parsed.message.content)) {
          const toolResults = parsed.message.content.filter((block) => block && block.type === 'tool_result');
          if (toolResults.length > 0) {
            onEvent && onEvent({ type: 'status', message: `Claude Code 已收到 ${toolResults.length} 个工具结果，正在继续分析。` });
          }
          return;
        }
        if (parsed.type === 'result') {
          finalResult = typeof parsed.result === 'string' && parsed.result.trim() !== '' ? parsed.result.trim() : finalResult;
          const duration = parsed.duration_ms ? `，耗时 ${Math.round(parsed.duration_ms / 1000)} 秒` : '';
          onEvent && onEvent({ type: 'status', message: `Claude Code 执行完成${duration}。` });
          return;
        }
        if (parsed.type === 'tool_use') {
          onEvent && onEvent({ type: 'status', message: formatToolUseStatus(parsed) });
        } else if (parsed.type === 'tool_result') {
          onEvent && onEvent({ type: 'status', message: 'Claude Code 已收到工具结果，正在继续分析。' });
        }
      }

      function handleStdout(chunk) {
        const text = chunk.toString('utf8');
        stdout += text;
        if (!streamJson) {
          return;
        }
        streamBuffer += text;
        const lines = streamBuffer.split(/\r?\n/);
        streamBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            emitClaudeCodeStreamEvent(line.trim());
          }
        }
      }

      child.stdout && child.stdout.on('data', handleStdout);
      child.stderr && child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        const publicError = new Error(error.code === 'ENOENT'
          ? `本机没有找到 Claude Code 命令，已尝试路径：${resolvedCommand}`
          : `本机 Claude Code 启动失败：${error.message || '未知错误'}`);
        publicError.code = error.code === 'ENOENT' ? 'LOCAL_CLAUDE_CODE_NOT_FOUND' : 'LOCAL_CLAUDE_CODE_START_FAILED';
        publicError.details = error.message || '';
        publicError.command = resolvedCommand;
        finishWithError(publicError);
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const details = stderr.trim();
          const error = new Error(details ? `本机 Claude Code 处理失败：${details}` : '本机 Claude Code 处理失败，请稍后重试。');
          error.code = 'LOCAL_CLAUDE_CODE_FAILED';
          error.details = details;
          error.command = resolvedCommand;
          reject(error);
          return;
        }
        if (streamJson && streamBuffer.trim()) {
          emitClaudeCodeStreamEvent(streamBuffer.trim());
        }
        const output = streamJson ? finalResult || streamedText || stdout.trim() : stdout.trim();
        resolve({ output, sessionId });
      });
    });
  };
}

const ALLOWED_LOCAL_SYNC_EVENT_TYPES = new Set([
  'memory.created',
  'memory.updated',
  'logic_assertion.created',
  'logic_assertion.updated'
]);

function isAllowedLocalSyncEventType(type) {
  return ALLOWED_LOCAL_SYNC_EVENT_TYPES.has(type);
}

function readAttachmentValue(attachment, keys) {
  for (const key of keys) {
    if (attachment && typeof attachment[key] === 'string' && attachment[key].trim() !== '') {
      return attachment[key].trim();
    }
  }
  return '';
}

function isSpreadsheetAttachment(name, mime) {
  return /\.xlsx?$/i.test(name || '') || /spreadsheet|excel/i.test(mime || '');
}

function hasSpreadsheetAttachment(input = {}) {
  return Array.isArray(input.localAttachments) && input.localAttachments.some((attachment) => {
    const name = readAttachmentValue(attachment, ['name', 'fileName']);
    const mime = readAttachmentValue(attachment, ['mime', 'mimeType']);
    return isSpreadsheetAttachment(name, mime);
  });
}

function formatLocalAttachmentContext(localAttachments = [], attachmentIds = []) {
  const attachments = Array.isArray(localAttachments) ? localAttachments.slice(0, 10) : [];
  if (attachments.length === 0) {
    return Array.isArray(attachmentIds) && attachmentIds.length > 0 ? `仅有附件 ID：${attachmentIds.join('、')}` : '无';
  }

  return attachments.map((attachment, index) => {
    const id = readAttachmentValue(attachment, ['id', 'attachmentId']);
    const name = readAttachmentValue(attachment, ['name', 'fileName']) || id || '未命名附件';
    const mime = readAttachmentValue(attachment, ['mime', 'mimeType']);
    const source = readAttachmentValue(attachment, ['source']) || 'unknown';
    const localPath = readAttachmentValue(attachment, ['localPath']);
    const spreadsheetHint = isSpreadsheetAttachment(name, mime) && localPath
      ? '解析建议：这是 Excel 文件，优先用 Bash 调用 node -e 结合 xlsx 包读取 workbook.SheetNames 和 XLSX.utils.sheet_to_json；不要逐字节读取整个二进制文件。'
      : '';
    return [
      `${index + 1}. ${name}`,
      id ? `附件 ID：${id}` : '',
      mime ? `MIME：${mime}` : '',
      Number.isFinite(attachment && attachment.size) ? `大小：${attachment.size} bytes` : '',
      `来源：${source}`,
      localPath ? `本机可读取路径：${localPath}` : '本机可读取路径：无',
      spreadsheetHint
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function buildLocalClaudeCodePrompt(input = {}) {
  const attachmentIds = Array.isArray(input.attachmentIds) ? input.attachmentIds : [];
  return [
    '你是白泽客户端本机 Claude Code 助手。',
    '你在客户端本地处理用户消息，可以像 Claude Code 客户端一样调用本地工具完成任务。',
    '你拥有客户端本地文件的新增、删除、查询、修改权限；执行前要确认用户意图清楚，不要越过用户请求范围。',
    '默认不要上报服务器；普通聊天、普通问答、普通分析、只读文件分析都只返回中文文本，不要输出 syncEvents。',
    '只有用户明确要求修改记忆或修改逻辑时，才输出 JSON 并带 syncEvents。',
    '插件调用不需要上报服务器授权请求；你只能根据客户端同步到的插件权限策略判断是否允许调用。',
    '如果插件权限策略不允许当前插件或动作，请直接用中文告诉用户当前客户端没有该权限，不要上报服务器请求同意。',
    '如果需要实时 Jira 数据或生成 Jira 创建确认卡，不要用 Bash、curl 或本地文件寻找 Jira 凭据；请输出 clientOperations JSON 让客户端执行插件桥操作。',
    'Jira 只读查询操作格式：{"reply":"","clientOperations":[{"id":"唯一ID","plugin":"jira","action":"search_issue","input":{}}]}。',
    'Jira search_issue 常用 input：{"projectKey":"BUG","statusCategory":"Done","maxResults":10,"orderBy":"resolutiondate DESC, updated DESC","fields":["summary","status","assignee","issuetype","project","created","updated","resolutiondate","statuscategorychangedate"],"includeCompletionTiming":true}。',
    'Jira 创建第一步只能生成待确认卡，不能直接创建；需要创建 Jira 单时必须输出 action 为 create_issue 的 clientOperations，input.drafts 为草稿数组，summary 必填，description、projectKey、issueType、assignee、priority、labels 可选。',
    'Jira create_issue 格式：{"reply":"白泽：已生成 Jira 草稿，请确认创建。","clientOperations":[{"id":"jira-create-1","plugin":"jira","action":"create_issue","input":{"drafts":[{"summary":"标题","description":"描述","projectKey":"项目Key","issueType":"任务","assignee":"负责人","labels":[]}]}}]}。',
    '不要只用普通文本说“现在调用 Jira 创建”；需要弹确认卡时必须输出 create_issue JSON。',
    '用户确认 Jira 创建后，你会收到已确认的 operation 上下文。此时你才可以输出 Jira 工具操作：get_project、get_create_meta、search_user、create_confirmed_issue，用这些工具分步校验项目、类型、用户和字段，再创建。',
    '确认后的 create_confirmed_issue 只允许使用已确认 operation 里的草稿内容或你根据 Jira 工具返回做出的安全字段格式修正；不要新增用户未确认的新需求单。',
    '确认后的 Jira 工具操作格式：{"reply":"","clientOperations":[{"id":"jira-tool-1","plugin":"jira","action":"get_project|get_create_meta|search_user|create_confirmed_issue","input":{}}]}。',
    '拿到 search_issue 客户端操作结果后，必须基于结果计算并回答用户要的数值；不要改算白泽自身耗时日志。',
    '拿到 create_issue 客户端操作结果后，只能告诉用户确认卡已生成，必须在客户端点击“确认创建”后才会真正写入 Jira。',
    '如果用户只是询问、讨论、分析、总结，不要为了记录审计或上下文输出 syncEvents。',
    '如果附件上下文包含本机可读取路径，请优先使用 Read 工具读取该路径；不要把本机路径写入 syncEvents 或客户端插件请求。',
    '如果附件是 xlsx/xls，不要用 Read 直接读取二进制内容；应使用 Bash 的 node -e 单行命令和项目已安装的 xlsx 包读取工作表、表头和行数据。',
    '解析 Excel 时只抽取回答用户问题需要的列和行；如果文件较大，先读取 sheet 名称、表头和前 50 行判断结构，再按条件读取必要范围。',
    '如果请求涉及 Jira Bug 工程分析，必须要求先完成 SVN 更新并基于工程目录分析；没有工程依据时只能说明待工程分析。',
    '输出普通回复时直接输出中文文本；需要上报或请求客户端操作时输出 JSON，不要使用 Markdown 代码块。',
    'JSON 格式：{"reply":"白泽：展示给用户的中文回复","syncEvents":[{"type":"memory.created|memory.updated|logic_assertion.created|logic_assertion.updated","payload":{}}],"clientOperations":[{"id":"唯一ID","plugin":"jira","action":"search_issue|create_issue|get_project|get_create_meta|search_user|create_confirmed_issue","input":{}}]}。',
    'syncEvents 只允许用于记忆修改和逻辑修改；不要把密钥、凭据、Cookie、token 放进 payload。',
    '请用中文回答，开头使用“白泽：”。',
    '',
    `用户消息：${input.text || ''}`,
    '',
    `会话 ID：${input.conversationId || '无'}`,
    `客户端 ID：${input.clientId || '无'}`,
    attachmentIds.length > 0 ? `附件 ID：${attachmentIds.join('、')}` : '附件 ID：无',
    `附件上下文：\n${formatLocalAttachmentContext(input.localAttachments, attachmentIds)}`,
    input.pluginPermissions ? `插件权限策略：${JSON.stringify(input.pluginPermissions)}` : '插件权限策略：无'
  ].join('\n');
}

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeSyncEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }
  return events
    .filter((event) => event && typeof event === 'object' && typeof event.type === 'string' && isAllowedLocalSyncEventType(event.type) && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
    .map((event) => ({
      type: event.type,
      payload: event.payload
    }));
}

const ALLOWED_JIRA_CLIENT_ACTIONS = ['search_issue', 'create_issue', 'get_project', 'get_create_meta', 'search_user', 'create_confirmed_issue'];

function normalizeClientOperations(operations) {
  if (!Array.isArray(operations)) {
    return [];
  }
  return operations
    .filter((operation) => operation
      && typeof operation === 'object'
      && operation.plugin === 'jira'
      && ALLOWED_JIRA_CLIENT_ACTIONS.includes(operation.action)
      && operation.input
      && typeof operation.input === 'object'
      && !Array.isArray(operation.input))
    .slice(0, 5)
    .map((operation, index) => ({
      id: typeof operation.id === 'string' && operation.id.trim() !== '' ? operation.id.trim() : `operation-${index + 1}`,
      plugin: 'jira',
      action: operation.action,
      input: operation.input
    }));
}

function parseLocalClaudeCodeOutput(output) {
  const text = String(output || '').trim();
  if (text === '') {
    return { reply: '白泽：本机 Claude Code 没有返回有效结果。', syncEvents: [], clientOperations: [] };
  }
  try {
    const parsed = JSON.parse(stripJsonFence(text));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        reply: typeof parsed.reply === 'string' && parsed.reply.trim() !== '' ? parsed.reply.trim() : text,
        syncEvents: normalizeSyncEvents(parsed.syncEvents),
        clientOperations: normalizeClientOperations(parsed.clientOperations)
      };
    }
  } catch (error) {
  }
  return { reply: text, syncEvents: [], clientOperations: [] };
}

function buildLocalImageAnalysisPrompt(input = {}) {
  return [
    '你是白泽客户端本机 Claude Code 图片分析助手。',
    '请使用本机文件工具读取并分析用户上传的图片，只输出 JSON，不要输出 Markdown 代码块。',
    '不要输出 syncEvents，不要输出 clientOperations，不要写入记忆，不要调用插件。',
    '不要把本机路径、env、token、API Key、Cookie 或任何凭据写入 JSON。',
    'JSON 字段必须为：{"summary":"中文图片内容摘要","memoryCategory":"project","shouldRemember":true,"reason":"是否建议加入记忆区的中文原因","extractedText":"图片中可识别文字，没有则为空字符串"}。',
    'memoryCategory 只能从 programming、design、art、general、pm、project 中选择；不确定时使用 project。',
    '',
    `文件名：${input.fileName || 'image'}`,
    input.mimeType ? `MIME：${input.mimeType}` : '',
    Number.isFinite(input.size) ? `大小：${input.size} bytes` : '',
    `本机可读取路径：${input.localPath || ''}`,
    '',
    '请现在读取图片并返回 JSON。'
  ].filter(Boolean).join('\n');
}

function readAnalysisText(value, limit = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function parseLocalImageAnalysisOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(output));
  } catch (error) {
    const parseError = new Error('本机 Claude Code 没有返回有效的图片分析 JSON。');
    parseError.code = 'LOCAL_IMAGE_ANALYSIS_PARSE_FAILED';
    throw parseError;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('本机 Claude Code 图片分析结果格式无效。');
    error.code = 'LOCAL_IMAGE_ANALYSIS_INVALID_RESULT';
    throw error;
  }
  const summary = readAnalysisText(parsed.summary, 1200);
  if (!summary) {
    const error = new Error('本机 Claude Code 图片分析结果缺少摘要。');
    error.code = 'LOCAL_IMAGE_ANALYSIS_SUMMARY_REQUIRED';
    throw error;
  }
  const memoryCategory = ['programming', 'design', 'art', 'general', 'pm', 'project'].includes(parsed.memoryCategory)
    ? parsed.memoryCategory
    : 'project';
  return {
    provider: 'local_claude_code',
    summary,
    memoryCategory,
    shouldRemember: parsed.shouldRemember !== false,
    reason: readAnalysisText(parsed.reason, 1200) || '客户端本机 Claude Code 已完成图片分析，等待用户确认是否加入记忆区。',
    extractedText: readAnalysisText(parsed.extractedText, 8000)
  };
}

async function analyzeLocalImageAttachment(input = {}, { runner = createLocalClaudeCodeRunner(), signal, localClaudeCodeEnv } = {}) {
  if (!input.localPath || typeof input.localPath !== 'string') {
    const error = new Error('图片缺少本机可读取路径，无法调用本机 Claude Code 分析。');
    error.code = 'LOCAL_IMAGE_PATH_REQUIRED';
    throw error;
  }
  const run = await runner({
    prompt: buildLocalImageAnalysisPrompt(input),
    signal,
    streamJson: false,
    env: localClaudeCodeEnv
  });
  return parseLocalImageAnalysisOutput(run && run.output);
}

function createLocalClaudeCodeChat({ runner = createLocalClaudeCodeRunner(), sessionStore } = {}) {
  const memorySessionStore = new Map();

  async function getSessionId(conversationId) {
    if (!conversationId) {
      return '';
    }
    if (sessionStore && typeof sessionStore.get === 'function') {
      return await sessionStore.get(conversationId) || '';
    }
    return memorySessionStore.get(conversationId) || '';
  }

  async function setSessionId(conversationId, sessionId) {
    if (!conversationId || !sessionId) {
      return;
    }
    if (sessionStore && typeof sessionStore.set === 'function') {
      await sessionStore.set(conversationId, sessionId);
      return;
    }
    memorySessionStore.set(conversationId, sessionId);
  }

  function buildClientOperationResultPrompt({ originalText, operations, results, mode }) {
    return [
      '客户端已按权限策略执行你请求的插件桥操作。',
      mode === 'jira_confirmed_execution'
        ? '这是用户已经确认后的 Jira 创建执行流程。请基于工具返回继续校验、修正字段格式或创建 Jira；失败时用中文说明原因和下一步，不要伪造成功。同一阶段不互相依赖的后续 Jira 工具要尽量合并到一个 clientOperations 数组里输出。'
        : '如果结果包含 Jira 创建 operation，说明客户端已生成待确认卡，请告诉用户在客户端确认卡中点击“确认创建”；不要声称已经真正创建 Jira。',
      '如果结果包含 timingAnalysis，必须基于真实结果给出平均完成时间。',
      '不要输出新的 clientOperations，除非结果明确不足以回答或确认后的 Jira 创建仍需继续调用 Jira 工具。',
      '',
      `用户原始问题：${originalText || ''}`,
      `请求的操作：${JSON.stringify(operations)}`,
      `操作结果：${JSON.stringify(results)}`
    ].join('\n');
  }

  function buildConfirmedJiraExecutionPrompt(input = {}) {
    return [
      '你是白泽客户端本机 Claude Code Jira 执行助手。',
      '用户已经在客户端确认卡中点击“确认创建 Jira 单”。现在允许你调用 Jira 插件工具执行这次已确认的 operation。',
      '不要使用 Bash、curl 或本地文件寻找 Jira 凭据；只能输出 clientOperations JSON，让客户端执行本地 Jira 插件工具。',
      '你应该调用 get_project、get_create_meta、search_user、create_confirmed_issue。可以根据前一步工具返回修正 issueType id、负责人 name/accountId、自定义字段格式或移除 Jira 创建界面不支持的可选字段。',
      '同一阶段不互相依赖的工具要尽量放在同一个 clientOperations 数组里一次输出，例如多个 search_user、多个 create_confirmed_issue 可以批量请求，避免反复等待。',
      '只能创建 operation.draftImport.drafts 中已经确认的草稿；不要新增用户没有确认的 Jira 单。',
      '如果 Jira 返回错误，请分析错误并继续安全修正；如果需要用户补充项目、类型、负责人或必填字段，请用中文说明，不要硬猜。',
      '输出 JSON，不要 Markdown 代码块。格式：{"reply":"白泽：中文状态","clientOperations":[{"id":"唯一ID","plugin":"jira","action":"get_project|get_create_meta|search_user|create_confirmed_issue","input":{}}]}。',
      '如果所有 Jira 单创建成功，直接中文总结创建结果，不要再输出 clientOperations。',
      '',
      `用户原始消息：${input.originalText || input.text || ''}`,
      `会话 ID：${input.conversationId || '无'}`,
      `客户端 ID：${input.clientId || '无'}`,
      `已确认 operation：${JSON.stringify(input.operation || {})}`
    ].join('\n');
  }

  async function runWithClientOperations(input = {}, { signal, onEvent, executeClientOperation, streamFinalEvents = false, localClaudeCodeEnv, mode } = {}) {
    let resumeSessionId = await getSessionId(input.conversationId);
    let prompt = mode === 'jira_confirmed_execution' ? buildConfirmedJiraExecutionPrompt(input) : buildLocalClaudeCodePrompt(input);
    const restrictTools = mode === 'jira_confirmed_execution' ? false : hasSpreadsheetAttachment(input);
    let parsed;
    const clientOperationResults = [];
    for (let round = 0; round < 8; round += 1) {
      const bufferedDeltas = [];
      const run = await runner({
        prompt,
        input,
        signal,
        onEvent: streamFinalEvents ? (event) => {
          if (event && event.type === 'delta') {
            bufferedDeltas.push(event);
            return;
          }
          if (typeof onEvent === 'function') {
            onEvent(event);
          }
        } : undefined,
        streamJson: true,
        resumeSessionId,
        env: localClaudeCodeEnv,
        restrictTools
      });
      resumeSessionId = run && run.sessionId ? run.sessionId : resumeSessionId;
      await setSessionId(input.conversationId, resumeSessionId);
      parsed = parseLocalClaudeCodeOutput(run && run.output);
      if (!parsed.clientOperations || parsed.clientOperations.length === 0 || typeof executeClientOperation !== 'function') {
        parsed.clientOperationResults = clientOperationResults;
        if (streamFinalEvents && typeof onEvent === 'function') {
          bufferedDeltas.forEach(onEvent);
        }
        return parsed;
      }
      const results = [];
      for (const operation of parsed.clientOperations) {
        const result = await executeClientOperation(operation);
        results.push(result);
        clientOperationResults.push(result);
      }
      parsed.clientOperationResults = clientOperationResults;
      prompt = buildClientOperationResultPrompt({ originalText: input.originalText || input.text, operations: parsed.clientOperations, results, mode });
    }
    return parsed || { reply: '白泽：客户端插件操作超过最大轮次，请缩小查询条件后重试。', syncEvents: [], clientOperations: [] };
  }

  function buildChatResult(input, parsed) {
    const clientOperationResults = Array.isArray(parsed.clientOperationResults) ? parsed.clientOperationResults : [];
    const jiraOperationResult = clientOperationResults.find((result) => result && result.plugin === 'jira' && result.action === 'create_issue' && result.operation);
    return {
      provider: 'local_claude_code',
      reply: parsed.reply,
      syncEvents: parsed.syncEvents,
      jiraOperation: jiraOperationResult ? jiraOperationResult.operation : null,
      message: {
        platform: 'desktop',
        userId: input.userId || 'desktop-user',
        conversationId: input.conversationId,
        clientId: input.clientId,
        text: input.text || ''
      },
      results: clientOperationResults
    };
  }

  async function send(input = {}, { signal, executeClientOperation, localClaudeCodeEnv, mode } = {}) {
    const parsed = await runWithClientOperations(input, { signal, executeClientOperation, localClaudeCodeEnv, mode });
    return buildChatResult(input, parsed);
  }

  async function sendStream(input = {}, { signal, onEvent, executeClientOperation, localClaudeCodeEnv, mode } = {}) {
    if (typeof onEvent === 'function') {
      onEvent({ type: 'status', message: mode === 'jira_confirmed_execution' ? '白泽正在调用本机 Claude Code 执行已确认的 Jira 操作。' : '白泽正在调用本机 Claude Code，全本地文件工具权限已启用。' });
    }
    const parsed = await runWithClientOperations(input, { signal, onEvent, executeClientOperation, streamFinalEvents: true, localClaudeCodeEnv, mode });
    const result = buildChatResult(input, parsed);
    if (typeof onEvent === 'function') {
      onEvent({ type: 'done', ...result });
    }
    return { type: 'done', ...result };
  }

  return {
    send,
    sendStream
  };
}

module.exports = {
  buildLocalClaudeCodePrompt,
  buildLocalImageAnalysisPrompt,
  createLocalClaudeCodeRunner,
  resolveClaudeCodeCommand,
  createLocalClaudeCodeChat,
  isAllowedLocalSyncEventType,
  parseLocalClaudeCodeOutput,
  parseLocalImageAnalysisOutput,
  analyzeLocalImageAttachment
};
