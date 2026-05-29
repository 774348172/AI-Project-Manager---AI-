const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');
const { getClaudeConfig, getGlobalConfig } = require('./config-service');

const DEFAULT_MODEL = 'claude-opus-4-7';
const MAX_HISTORY_MESSAGES = 40;
const MAX_JIRA_DRAFT_TOKENS = 128000;

function configurationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function createAnthropicClient({ apiKey, authToken, baseURL } = {}) {
  if (!apiKey && !authToken) {
    throw configurationError('服务器尚未配置可用的大模型认证信息。');
  }

  return new Anthropic({ apiKey, authToken, baseURL });
}

function formatKnowledgeContext(results) {
  if (results.length === 0) {
    return '本地知识库没有检索到相关内容。';
  }

  return results
    .map((result, index) => [
      `${index + 1}. ${result.title}`,
      `来源：${result.relativePath}`,
      `摘要：${result.snippet}`
    ].join('\n'))
    .join('\n\n');
}

function formatShallowMemoryContext(results) {
  if (!results || results.length === 0) {
    return '没有检索到相关浅层记忆。';
  }

  return results
    .map((result, index) => `${index + 1}. [${result.category}] ${result.line}`)
    .join('\n');
}

function formatContextEntries(entries, emptyText) {
  if (!entries || entries.length === 0) {
    return emptyText;
  }

  return entries
    .filter((entry) => entry.content && entry.content.trim() !== '')
    .map((entry, index) => [
      `${index + 1}. ${entry.category || entry.name || entry.id}`,
      `来源：${entry.relativePath}`,
      entry.content.trim()
    ].join('\n'))
    .join('\n\n') || emptyText;
}

function formatLogicContext(logicContext = {}) {
  return [
    `逻辑断言：\n${formatContextEntries(logicContext.assertions, '没有逻辑断言。')}`,
    `逻辑规则：\n${formatContextEntries(logicContext.rules, '没有逻辑规则。')}`,
    `可执行规则配置：\n${formatContextEntries(logicContext.executableRules, '没有可执行规则配置。')}`
  ].join('\n\n');
}

function formatSkillsContext(skillsContext = {}) {
  const registry = skillsContext.registry && skillsContext.registry.trim() !== ''
    ? skillsContext.registry.trim()
    : '没有 skills registry。';
  const skills = skillsContext.skills && skillsContext.skills.length > 0
    ? skillsContext.skills.map((skill, index) => [
      `${index + 1}. ${skill.id}`,
      `来源：${skill.relativePath}`,
      skill.skillMarkdown && skill.skillMarkdown.trim() !== '' ? `说明：\n${skill.skillMarkdown.trim()}` : '说明：未配置。',
      skill.configYaml && skill.configYaml.trim() !== '' ? `配置：\n${skill.configYaml.trim()}` : '配置：未配置。'
    ].join('\n')).join('\n\n')
    : '没有 skills。';

  return [`Skills registry：\n${registry}`, `Skills：\n${skills}`].join('\n\n');
}

function formatSystemPrompt({ markdown, config }) {
  const configText = Object.keys(config).length === 0 ? '' : JSON.stringify(config, null, 2);
  return [
    '你是白泽，一个运行在用户自有服务器上的项目智能中枢。',
    '你必须默认使用中文回答，并保持直接、可靠、面向执行的风格。',
    '客户端、企业微信和其它插件都只是入口；服务器负责记忆、逻辑、知识库和 Claude 推理。',
    markdown.trim() === '' ? '' : `白泽全局设定：\n${markdown.trim()}`,
    configText === '' ? '' : `结构化配置：\n${configText}`
  ].filter(Boolean).join('\n\n');
}

function formatConversationHistory(messages = []) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message.role) && message.text)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: [
        {
          type: 'text',
          text: message.text
        }
      ]
    }));
}

function extractText(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function normalizeImageMediaType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (nestedError) {
      return null;
    }
  }
}

const CHAT_ROUTE_CLASSIFICATIONS = new Set([
  'ordinary_chat',
  'operation',
  'dangerous',
  'ambiguous',
  'other',
  'jira_create',
  'jira_search',
  'engineering_readonly',
  'engineering_write',
  'engineering_test'
]);

const OPERATION_ROUTE_ALIASES = new Set([
  'other',
  'jira_create',
  'jira_search',
  'engineering_readonly',
  'engineering_write',
  'engineering_test'
]);

function normalizeChatRouteClassification(text) {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const rawRoute = typeof parsed.route === 'string' ? parsed.route.trim() : '';
  if (!CHAT_ROUTE_CLASSIFICATIONS.has(rawRoute)) {
    return null;
  }

  const route = OPERATION_ROUTE_ALIASES.has(rawRoute) ? 'operation' : rawRoute;
  const confidence = Number(parsed.confidence);
  return {
    route,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 300) : '',
    requiresConfirmation: ['operation', 'dangerous', 'ambiguous'].includes(route)
  };
}

function parseImageAnalysis(text, fileName) {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') {
    return {
      summary: text && text.trim() !== '' ? text.trim() : `已完成图片 ${fileName} 的视觉分析。`,
      memoryCategory: 'project',
      shouldRemember: true,
      reason: '图片内容可能包含用户提供的上下文，建议由用户确认后加入记忆区。',
      extractedText: ''
    };
  }

  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() !== '' ? parsed.summary.trim() : `已完成图片 ${fileName} 的视觉分析。`,
    memoryCategory: typeof parsed.memoryCategory === 'string' && parsed.memoryCategory.trim() !== '' ? parsed.memoryCategory.trim() : 'project',
    shouldRemember: typeof parsed.shouldRemember === 'boolean' ? parsed.shouldRemember : true,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() !== '' ? parsed.reason.trim() : '图片内容可能包含用户提供的上下文，建议由用户确认后加入记忆区。',
    extractedText: typeof parsed.extractedText === 'string' ? parsed.extractedText.trim() : ''
  };
}

async function buildClaudeRequest({
  message,
  knowledgeResults,
  shallowMemoryResults,
  logicContext,
  skillsContext,
  conversationMessages,
  conversationSummary,
  baizeRoot,
  model
} = {}) {
  const claudeConfig = await getClaudeConfig({ baizeRoot });
  const selectedModel = model || claudeConfig.model || DEFAULT_MODEL;
  const globalConfig = await getGlobalConfig({ baizeRoot });
  const systemPrompt = formatSystemPrompt(globalConfig);
  const knowledgeContext = formatKnowledgeContext(knowledgeResults || []);
  const shallowMemoryContext = formatShallowMemoryContext(shallowMemoryResults || []);
  const logicContextText = formatLogicContext(logicContext);
  const skillsContextText = formatSkillsContext(skillsContext);
  const historyMessages = formatConversationHistory(conversationMessages);
  const summaryText = conversationSummary && conversationSummary.trim() !== ''
    ? conversationSummary.trim()
    : '暂无会话摘要。';

  return {
    claudeConfig,
    request: {
      model: selectedModel,
      max_tokens: 1200,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `入口平台：${message.platform}`,
                `用户 ID：${message.userId || 'unknown'}`,
                `会话 ID：${message.conversationId || 'unknown'}`,
                `会话摘要：\n${summaryText}`,
                `本地知识库上下文：\n${knowledgeContext}`,
                `浅层记忆上下文：\n${shallowMemoryContext}`,
                `逻辑断言与规则上下文：\n${logicContextText}`,
                `技能上下文：\n${skillsContextText}`,
                `用户问题：${message.text}`,
                '下面是该会话最近的历史消息。请在回答当前用户问题时结合这些历史。'
              ].join('\n\n')
            }
          ]
        },
        ...historyMessages,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `用户问题：${message.text}`
            }
          ]
        }
      ]
    }
  };
}

function spreadsheetMimeType(fileName = '') {
  return /\.xls$/i.test(fileName)
    ? 'application/vnd.ms-excel'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

function isFileApiUnavailable(error) {
  const status = error && (error.status || error.statusCode);
  return status === 404 || status === 405 || /404 page not found|not found|files/i.test(error && error.message ? error.message : '');
}

function workbookToBoundedText(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sections = [];
  for (const sheetName of workbook.SheetNames.slice(0, 8)) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }).slice(0, 200);
    const textRows = rows
      .map((row) => row.map((cell) => String(cell || '').trim()).filter(Boolean).join(' | '))
      .filter(Boolean);
    if (textRows.length > 0) {
      sections.push(`工作表：${sheetName}\n${textRows.join('\n')}`);
    }
  }
  return sections.join('\n\n').slice(0, 60000);
}

async function continueIfTruncated({ anthropic, requestOptions, baseRequest, initialResponse, onTiming, timingKey }) {
  if (!initialResponse || initialResponse.stop_reason !== 'max_tokens') {
    return extractText(initialResponse);
  }
  const firstText = extractText(initialResponse);
  const continueStartedAt = Date.now();
  const followUpRequest = {
    ...baseRequest,
    messages: [
      ...baseRequest.messages,
      { role: 'assistant', content: [{ type: 'text', text: firstText }] },
      { role: 'user', content: [{ type: 'text', text: '上一次输出被 max_tokens 截断了。请从被截断的位置继续输出剩余的 Jira 草稿，保持同样的字段格式；不要重复上面已经输出过的草稿，也不要重新解释，直接接着写。' }]
      }
    ]
  };
  const followUp = await anthropic.messages.create(followUpRequest, requestOptions);
  if (typeof onTiming === 'function' && timingKey) {
    onTiming(`${timingKey}ContinueMs`, Date.now() - continueStartedAt);
    onTiming(`${timingKey}Continued`, 1);
  }
  const followUpText = extractText(followUp);
  return [firstText, followUpText].filter((part) => part && part.trim()).join('\n\n');
}

async function generateJiraDraftTextFromWorkbookText({ fileName, workbookText, userText, claudeConfig, anthropic, onTiming } = {}) {
  const requestStartedAt = Date.now();
  const baseRequest = {
    model: claudeConfig.model || DEFAULT_MODEL,
    max_tokens: MAX_JIRA_DRAFT_TOKENS,
    thinking: { type: 'adaptive' },
    system: [{
      type: 'text',
      text: [
        '你是白泽服务器上的 Jira 批量导入解析器。',
        '服务器已将用户上传的 Excel 工作簿转换为纯文本表格内容。',
        '必须基于表格内容生成 Jira 草稿，忽略空行和说明性标题行。',
        '只输出纯文本，不要解释，不要 Markdown 代码块。',
        '每个 Jira 单使用多行字段，字段名只允许：标题、描述、项目、类型、负责人、优先级、标签。',
        '不要输出状态、status、流程节点、枚举值等 Jira 创建字段之外的信息。',
        '多个 Jira 单之间用一个空行分隔。',
        '如果表格里没有项目或类型，可以省略，由服务器默认配置补齐。'
      ].join('\n')
    }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: [`文件名：${fileName}`, `用户请求：${userText || ''}`, 'Excel 文本内容：', workbookText].join('\n')
      }]
    }]
  };
  const response = await anthropic.messages.create(baseRequest);
  if (typeof onTiming === 'function') {
    onTiming('claudeJiraDraftMs', Date.now() - requestStartedAt);
  }
  return continueIfTruncated({
    anthropic,
    baseRequest,
    initialResponse: response,
    onTiming,
    timingKey: 'claudeJiraDraft'
  });
}

async function generateJiraDraftTextFromXlsx({ fileName = 'jira-import.xlsx', buffer, userText, baizeRoot, client, onTiming } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw configurationError('xlsx 文件内容不能为空。');
  }
  const claudeConfig = await getClaudeConfig({ baizeRoot });
  const anthropic = client || createAnthropicClient(claudeConfig);
  const uploadStartedAt = Date.now();
  let uploaded;
  try {
    const file = await Anthropic.toFile(buffer, fileName, { type: spreadsheetMimeType(fileName) });
    uploaded = await anthropic.beta.files.upload({ file });
  } catch (error) {
    if (!isFileApiUnavailable(error)) {
      throw error;
    }
    if (typeof onTiming === 'function') {
      onTiming('claudeJiraFileUploadMs', Date.now() - uploadStartedAt);
      onTiming('claudeJiraFileUploadFallback', 1);
    }
    return generateJiraDraftTextFromWorkbookText({
      fileName,
      workbookText: workbookToBoundedText(buffer),
      userText,
      claudeConfig,
      anthropic,
      onTiming
    });
  }
  if (typeof onTiming === 'function') {
    onTiming('claudeJiraFileUploadMs', Date.now() - uploadStartedAt);
  }

  const requestStartedAt = Date.now();
  const baseRequest = {
    model: claudeConfig.model || DEFAULT_MODEL,
    max_tokens: MAX_JIRA_DRAFT_TOKENS,
    thinking: { type: 'adaptive' },
    tools: [{ name: 'code_execution', type: 'code_execution_20250522' }],
    system: [{
      type: 'text',
      text: [
        '你是白泽服务器上的 Jira 批量导入解析器。',
        '用户上传了原始 Excel 文件，请使用 code_execution 读取工作簿和所有工作表，不要要求用户重新粘贴内容。',
        '必须基于 Excel 原始内容生成 Jira 草稿，忽略空行和说明性标题行。',
        '只输出纯文本，不要解释，不要 Markdown 代码块。',
        '每个 Jira 单使用多行字段，字段名只允许：标题、描述、项目、类型、负责人、优先级、标签。',
        '不要输出状态、status、流程节点、枚举值等 Jira 创建字段之外的信息。',
        '多个 Jira 单之间用一个空行分隔。',
        '如果表格里没有项目或类型，可以省略，由服务器默认配置补齐。'
      ].join('\n')
    }],
    messages: [{
      role: 'user',
      content: [
        { type: 'container_upload', file_id: uploaded.id },
        {
          type: 'text',
          text: [`文件名：${fileName}`, `用户请求：${userText || ''}`, '请读取上传的 Excel 文件，输出可由服务器解析的 Jira 草稿文本。'].join('\n')
        }
      ]
    }]
  };
  const requestOptions = {
    headers: { 'anthropic-beta': 'code-execution-2025-05-22' }
  };
  const response = await anthropic.messages.create(baseRequest, requestOptions);
  if (typeof onTiming === 'function') {
    onTiming('claudeJiraDraftMs', Date.now() - requestStartedAt);
  }
  return continueIfTruncated({
    anthropic,
    requestOptions,
    baseRequest,
    initialResponse: response,
    onTiming,
    timingKey: 'claudeJiraDraft'
  });
}

function formatRouteHistory(messages = []) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message.role) && message.text)
    .slice(-8)
    .map((message) => `${message.role === 'user' ? '用户' : '白泽'}：${message.text}`)
    .join('\n') || '无历史消息。';
}

function formatRouteAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return '无附件。';
  }
  return attachments.slice(0, 10).map((attachment, index) => [
    `${index + 1}. ${attachment.fileName || attachment.name || attachment.id || 'unnamed'}`,
    attachment.type ? `类型：${attachment.type}` : '',
    attachment.summary ? `摘要：${attachment.summary}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');
}

async function generateChatRouteClassification(input = {}) {
  const { client, onTiming } = input;
  const claudeConfig = await getClaudeConfig({ baizeRoot: input.baizeRoot });
  const anthropic = client || createAnthropicClient(claudeConfig);
  const summaryText = input.conversationSummary && input.conversationSummary.trim() !== ''
    ? input.conversationSummary.trim()
    : '暂无会话摘要。';
  const request = {
    model: input.model || claudeConfig.model || DEFAULT_MODEL,
    max_tokens: 500,
    thinking: { type: 'adaptive' },
    system: [{
      type: 'text',
      text: [
        '你是白泽服务器的轻量聊天分类器，只负责判断当前用户消息是不是普通聊天。',
        '你不能回答用户问题，不能创建 Jira，不能执行代码，不能请求或使用任何凭据。',
        '不要判断 Jira、工程、逻辑断言、附件解析等具体业务意图；这些全部交给 Claude Code。',
        '只输出严格 JSON，不要输出 Markdown 代码块或解释。',
        'route 只能是 ordinary_chat、operation、dangerous、ambiguous。',
        'ordinary_chat：普通问答、闲聊、解释概念，不需要读取/修改本地工程，不需要解析附件，不涉及 Jira/插件/逻辑断言/执行操作。',
        'operation：所有非普通聊天的请求，包括 Jira、工程分析、附件解析、逻辑断言、测试构建、插件操作、确认/取消/修改已有操作等。',
        'dangerous：删除数据、破坏性 git、泄露/读取密钥、绕过安全、DoS 或明显高风险请求。',
        'ambiguous：无法确定是否普通聊天；宁可归为 ambiguous，让 Claude Code 继续判断。',
        '输出格式：{"route":"ordinary_chat","confidence":0.0,"reason":"简短中文原因","requiresConfirmation":false}'
      ].join('\n'),
      cache_control: { type: 'ephemeral' }
    }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: [
          `入口平台：${input.message && input.message.platform ? input.message.platform : 'unknown'}`,
          `会话 ID：${input.message && input.message.conversationId ? input.message.conversationId : 'unknown'}`,
          `会话摘要：\n${summaryText}`,
          `最近历史：\n${formatRouteHistory(input.conversationMessages)}`,
          `知识库检索摘要：\n${formatKnowledgeContext(input.knowledgeResults || [])}`,
          `附件摘要：\n${formatRouteAttachments(input.attachments)}`,
          `当前用户消息：${input.message && input.message.text ? input.message.text : ''}`
        ].join('\n\n')
      }]
    }]
  };

  const requestStartedAt = Date.now();
  const response = await anthropic.messages.create(request);
  if (typeof onTiming === 'function') {
    onTiming('claudeRouteClassifierMs', Date.now() - requestStartedAt);
  }

  return normalizeChatRouteClassification(extractText(response));
}

async function generateClaudeReply(input = {}) {
  const { client, onTiming } = input;
  const { claudeConfig, request } = await buildClaudeRequest(input);
  const anthropic = client || createAnthropicClient(claudeConfig);

  const requestStartedAt = Date.now();
  const response = await anthropic.messages.create(request);
  if (typeof onTiming === 'function') {
    onTiming('claudeApiMs', Date.now() - requestStartedAt);
  }

  const text = extractText(response);
  return text || '白泽：我已收到请求，但没有生成有效回复。';
}

async function generateClaudeReplyStream(input = {}) {
  const { client, onDelta, onTiming } = input;
  const { claudeConfig, request } = await buildClaudeRequest(input);
  const anthropic = client || createAnthropicClient(claudeConfig);
  const requestStartedAt = Date.now();
  const stream = anthropic.messages.stream(request);
  let streamedText = '';

  stream.on('text', (text) => {
    streamedText += text;
    if (typeof onDelta === 'function') {
      onDelta(text);
    }
  });

  const finalMessage = await stream.finalMessage();
  if (typeof onTiming === 'function') {
    onTiming('claudeApiMs', Date.now() - requestStartedAt);
  }

  const finalText = extractText(finalMessage);
  return finalText || streamedText.trim() || '白泽：我已收到请求，但没有生成有效回复。';
}

async function analyzeImageAttachment(input = {}) {
  const { client, fileName = 'image', mimeType, contentBase64, baizeRoot } = input;
  const mediaType = normalizeImageMediaType(mimeType);
  if (!mediaType) {
    throw configurationError('当前图片格式暂不支持视觉识别。');
  }
  if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') {
    throw configurationError('图片内容不能为空。');
  }

  const claudeConfig = await getClaudeConfig({ baizeRoot });
  if (claudeConfig.enabled === false || (!claudeConfig.apiKey && !claudeConfig.authToken)) {
    throw configurationError('服务器尚未配置可用的大模型视觉能力。');
  }

  const anthropic = client || createAnthropicClient(claudeConfig);
  let response;
  try {
    response = await anthropic.messages.create({
      model: claudeConfig.model || DEFAULT_MODEL,
      max_tokens: 1000,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: contentBase64
              }
            },
            {
              type: 'text',
              text: [
                `请分析这张用户上传到白泽的图片，文件名：${fileName}。`,
                '请用中文返回 JSON，不要输出 Markdown 代码块，字段如下：',
                '{"summary":"图片内容摘要","memoryCategory":"project","shouldRemember":true,"reason":"是否建议加入记忆区的原因","extractedText":"图片里可识别的文字，没有则为空字符串"}',
                '如果图片包含界面、报错、文档、设计稿或项目上下文，请重点描述对后续对话有帮助的信息。'
              ].join('\n')
            }
          ]
        }
      ]
    });
  } catch (error) {
    const status = error && (error.status || error.statusCode);
    if (status === 401) {
      throw configurationError('服务器大模型认证失败：Claude API Key 或 Auth Token 无效，请检查服务器 Claude 配置。');
    }
    throw error;
  }

  return parseImageAnalysis(extractText(response), fileName);
}

module.exports = {
  DEFAULT_MODEL,
  createAnthropicClient,
  generateChatRouteClassification,
  generateClaudeReply,
  generateClaudeReplyStream,
  generateJiraDraftTextFromXlsx,
  analyzeImageAttachment
};
