const path = require('path');
const paths = require('../config/paths');
const { generateChatRouteClassification, generateClaudeReply, generateClaudeReplyStream, generateJiraDraftTextFromXlsx } = require('./claude-service');
const { runClaudeCodeTask } = require('./claude-code-service');
const {
  appendConversationMessage,
  ensureConversation,
  getConversationMessages
} = require('./conversation-service');
const { observeConversationTurn } = require('./conversation-manager-service');
const { getClaudeConfig, getClaudeCodeConfig, getJiraConfig } = require('./config-service');
const { classifyEngineeringIntent, shouldUseClaudeCode } = require('./engineering-intent-service');
const { searchKnowledgeBase } = require('./knowledge-base-service');
const { getLogicContext, submitLogicAssertion } = require('./logic-service');
const { searchShallowMemory } = require('./memory-service');
const { getSkillsContext } = require('./plugin-service');
const fs = require('fs/promises');
const { appendJsonLine } = require('../lib/file-store');
const { createPendingOperation } = require('./pending-operation-service');
const { searchAndAnalyzeJira } = require('./jira-search-service');
const { addJiraComment, deleteJiraAuthorComments, updateJiraIssue, transitionJiraIssue, deleteJiraIssue } = require('./jira-client-service');
const { auditPluginOperation } = require('./plugin-gateway-service');
const { createPendingAudit, markPendingAuditStatus, getPendingAudit } = require('./pending-audit-service');
const { getAttachment, listConversationAttachments, ensureSpreadsheetSemanticExtraction } = require('./attachment-service');
const { createJiraImportDrafts } = require('./jira-import-service');
const { createJiraCreateOperation, getJiraOperation, getLatestAwaitingJiraOperation, enrichJiraDrafts, updateJiraOperationDrafts, confirmJiraOperation, markJiraOperationProjectRequired, attachJiraOperationRecovery, buildDefaultRecoveryFromFailure, rejectJiraOperation } = require('./jira-operation-service');
const { createOrResumeBugAnalysisRun } = require('./jira-bug-analysis-service');

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function requireText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw validationError('text is required.');
  }

  return text.trim();
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readString).filter(Boolean).slice(0, 10);
}

function normalizeMessage({ text, userId, conversationId, clientId, platform, attachmentIds } = {}) {
  return {
    platform: readString(platform) || 'desktop',
    userId: readString(userId),
    conversationId: readString(conversationId),
    clientId: readString(clientId),
    text: requireText(text),
    attachmentIds: normalizeAttachmentIds(attachmentIds)
  };
}

function sanitizeResults(results) {
  return results.map((result) => ({
    source: result.source,
    title: result.title,
    relativePath: result.relativePath,
    snippet: result.snippet,
    score: result.score
  }));
}

function formatReply(query, results) {
  if (results.length === 0) {
    return `白泽：我已收到「${query}」，但暂时没有在本地知识库中找到相关内容。`;
  }

  const lines = results.map((result, index) => `${index + 1}. ${result.title}：${result.snippet}`);
  return `白泽：我在本地知识库中找到这些相关内容：\n${lines.join('\n')}`;
}

function formatEngineeringBlockedReply(intent) {
  if (intent && intent.route === 'dangerous') {
    return '白泽：这个操作风险较高，当前阶段不会执行。';
  }

  return '白泽：这个任务需要修改文件或运行命令。为了安全，需要先确认后才能生成补丁草案。';
}

function formatPendingOperationReply(operation) {
  return `白泽：这个任务需要修改代码。我可以先让 Claude Code 生成补丁草案，但不会直接修改你的本地文件。请确认是否生成补丁草案。操作 ID：${operation.id}`;
}

function toPermissionRequired(operation) {
  return {
    operationId: operation.id,
    kind: 'claude_code_write_proposal',
    title: '需要确认后生成代码补丁',
    message: '白泽可以生成补丁草案，但不会直接修改你的本地工作区。',
    requestedMode: operation.permission.mode,
    riskLevel: operation.risk.level,
    expiresAt: operation.expiresAt,
    actions: [
      { id: 'confirm', label: '生成补丁草案' },
      { id: 'reject', label: '取消' }
    ]
  };
}

function formatAmbiguousEngineeringReply() {
  return '白泽：这个工程问题还不够明确。请告诉我你希望我只读分析什么文件、接口、报错或功能，我会先进行只读排查。';
}

function shouldCreateJiraIssue(text) {
  const query = text.toLowerCase();
  return query.includes('jira') && /(创建|新建|新增|增加|批量|导入|生成).*(需求|需求单|任务|issue|单子)|(?:需求|需求单|任务|issue|单子).*(创建|新建|新增|增加|批量|导入|生成)/i.test(text);
}

function shouldConfirmPendingOperation(text) {
  return /^(确认|确定|同意|可以|创建|开始创建|确认创建|执行)$/i.test(text.trim());
}

function shouldRejectPendingOperation(text) {
  return /^(取消|放弃|不创建|不用了|取消创建)$/i.test(text.trim());
}

function getUserInstructionText(text) {
  const value = String(text || '').trim();
  const attachmentContextIndex = value.indexOf('以下是本次发送同时上传到服务器的附件分析结果');
  if (attachmentContextIndex !== -1) {
    return value.slice(0, attachmentContextIndex).trim() || value;
  }
  return value;
}

function sanitizeJiraDraft(draft = {}) {
  const sanitized = {
    summary: readString(draft.summary),
    description: typeof draft.description === 'string' ? draft.description : '',
    projectKey: readString(draft.projectKey),
    issueType: readString(draft.issueType),
    assignee: readString(draft.assignee),
    priority: readString(draft.priority),
    labels: Array.isArray(draft.labels) ? draft.labels.map(readString).filter(Boolean) : []
  };
  for (const key of ['issueTypeId', 'projectName', 'assigneeName', 'assigneeAccountId']) {
    const value = readString(draft[key]);
    if (value) {
      sanitized[key] = value;
    }
  }
  if (typeof draft.projectValid === 'boolean') {
    sanitized.projectValid = draft.projectValid;
  }
  return sanitized;
}

function isLogicAssertionInstruction(text) {
  return /(逻辑官|逻辑断言|断言|规则|记忆官).{0,20}(新增|新加|增加|加一条|补充|更新|记录)|(新增|新加|增加|加一条|补充|更新|记录).{0,20}(逻辑官|逻辑断言|断言|规则|记忆官)/.test(String(text || ''));
}

function extractLogicAssertionStatement(text) {
  const source = String(text || '').trim();
  if (!isLogicAssertionInstruction(source)) {
    return null;
  }
  return source
    .replace(/^这里/, '')
    .replace(/^(?:请|帮我)?(?:新增|新加|增加|加一条|补充|更新|记录)?(?:一条)?(?:丰富的)?(?:逻辑官|逻辑断言|断言|规则|记忆官)\s*/u, '')
    .replace(/^(?:请|帮我)?(?:在)?(?:逻辑官|逻辑断言|断言|规则|记忆官)(?:里|中)?(?:新增|新加|增加|加一条|补充|更新|记录)(?:一条)?\s*/u, '')
    .trim() || source;
}

function formatLogicAssertionReply(result, statement) {
  return `白泽：已新增逻辑断言。\n\n- 分类：${result.category}\n- 断言：${statement}`;
}

function extractJiraDraftPatch(text) {
  if (isLogicAssertionInstruction(text)) {
    return null;
  }
  const patch = {};
  const projectMatch = text.match(/(?:项目\s*(?:的)?\s*(?:key|Key|KEY)|project\s*(?:key)?)\s*(?:是|为|:|：)?\s*([A-Za-z][A-Za-z0-9_-]*)/i);
  if (projectMatch) {
    patch.projectKey = projectMatch[1];
  }
  const assigneeMatch = text.match(/(?:负责人|经办人|处理人)\s*(?:是|为|:|：)?\s*([一-龥A-Za-z0-9_.-]+)/);
  if (assigneeMatch) {
    patch.assignee = assigneeMatch[1];
  }
  const summaryMatch = text.match(/(?:标题|名称|单子名字|需求单名字|任务名字)\s*(?:改成|改为|是|为|叫做|:|：)\s*([^，,。；;\n]+)/);
  if (summaryMatch) {
    patch.summary = summaryMatch[1].trim();
  }
  const descriptionMatch = text.match(/(?:描述|内容|需求描述)\s*(?:改成|改为|是|为|:|：)\s*([^\n]+)/);
  if (descriptionMatch) {
    patch.description = descriptionMatch[1].trim();
  }
  const issueTypeMatch = text.match(/(?:类型|需求类型|任务类型)\s*(?:改成|改为|是|为|:|：)\s*([一-龥A-Za-z0-9_.-]+)/);
  if (issueTypeMatch) {
    patch.issueType = issueTypeMatch[1];
  }
  const priorityMatch = text.match(/(?:优先级|priority)\s*(?:改成|改为|是|为|:|：)\s*([一-龥A-Za-z0-9_.-]+)/i);
  if (priorityMatch) {
    patch.priority = priorityMatch[1];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function formatJiraDraftUpdateReply(operation) {
  const draft = operation.draftImport.drafts[0] || {};
  return ['白泽：已更新 Jira 草稿。', '', '当前 Jira 单草稿：', `- 项目 Key：${draft.projectKey || '未设置'}`, `- 单子名称：${draft.summary || '未设置'}`, `- 类型：${draft.issueType || '未设置'}`, `- 负责人：${draft.assignee || '未设置'}`, '', '如需创建，请点击确认按钮，或回复“确认创建”。'].join('\n');
}

function shouldUseJiraPlugin(text) {
  const query = text.toLowerCase();
  return query.includes('jira') && /(查询|拉取|筛选|分析|状态|需求单|issue)/i.test(text);
}

const JIRA_COMMENT_VERBS = /(写入|添加|加|增加|补|发|留|提交|写一条|写一句)\s*(?:一个|一条|一句)?\s*(评论|备注|comment)/i;
const JIRA_ISSUE_KEY_PATTERN = /\b([A-Z][A-Z0-9_]{0,15}-\d+)\b/;

function extractJiraCommentRequest(text) {
  const source = String(text || '');
  const issueKeyMatch = source.match(JIRA_ISSUE_KEY_PATTERN);
  if (!issueKeyMatch) {
    return null;
  }
  if (!JIRA_COMMENT_VERBS.test(source)) {
    return null;
  }
  const colonMatch = source.match(/(?:评论|备注|comment)\s*(?:内容)?\s*[:：]?\s*([\s\S]+)$/i);
  let body = colonMatch ? colonMatch[1] : null;
  if (body) {
    body = body.replace(/^[“”"'\s]+|[“”"'\s]+$/g, '');
  }
  if (!body) {
    return null;
  }
  return { issueKey: issueKeyMatch[1], body };
}

function shouldAddJiraComment(text) {
  return Boolean(extractJiraCommentRequest(text));
}

const JIRA_SUMMARIZE_COMMENT_VERBS = /(总结|汇总|梳理|整理|起草|写一段|写一篇|拟一段|拟一份|帮我写|草拟|同步进展).*(评论|备注|comment)|(评论|备注|comment).*(总结|汇总|梳理|整理|起草|草拟)/i;

function extractJiraSummarizeCommentRequest(text) {
  const source = String(text || '');
  const issueKeyMatch = source.match(JIRA_ISSUE_KEY_PATTERN);
  if (!issueKeyMatch) {
    return null;
  }
  if (extractJiraCommentRequest(source)) {
    return null;
  }
  if (!JIRA_SUMMARIZE_COMMENT_VERBS.test(source)) {
    return null;
  }
  return { issueKey: issueKeyMatch[1] };
}

function shouldSummarizeJiraComment(text) {
  return Boolean(extractJiraSummarizeCommentRequest(text));
}

const JIRA_BULK_COMMENT_VERBS = /(批量|一次性|统一|逐个|分别|挨个|挨次)[^，。\n]{0,20}(评论|备注|comment)|(评论|备注|comment)[^，。\n]{0,20}(批量|一次性|统一|挨个)/i;

function extractJiraBulkCommentRequest(text) {
  const source = String(text || '');
  const seen = new Set();
  const issueKeys = [];
  const re = /\b([A-Z][A-Z0-9_]{0,15}-\d+)\b/g;
  let match;
  while ((match = re.exec(source))) {
    const key = match[1];
    if (!seen.has(key)) {
      seen.add(key);
      issueKeys.push(key);
    }
  }
  if (issueKeys.length < 2) {
    return null;
  }
  const mentionsComment = /(评论|备注|comment)/i.test(source);
  if (!mentionsComment) {
    return null;
  }
  if (extractJiraCommentRequest(source)) {
    return null;
  }
  if (!JIRA_BULK_COMMENT_VERBS.test(source) && !/(写一段|起草|总结|汇总|同步|发).{0,10}(评论|备注|comment)/i.test(source)) {
    return null;
  }
  return { issueKeys };
}

function shouldBulkAddJiraComment(text) {
  return Boolean(extractJiraBulkCommentRequest(text));
}

const JIRA_OPERATION_INTENT_HINTS = /(分析|排查|定位|根因|原因|结论|处理建议|AI\s*分析|ai\s*分析|评论草稿|写上评论|写评论|自动.*评论|启动|开始|继续|恢复)/i;
const JIRA_CONTEXT_REFERENCE_HINTS = /(jira|Jira|JIRA|BUG\s*单|Bug\s*单|bug\s*单|这(?:些|几个|四个|十个)?\s*BUG|这些单|这几个单|这四个单|上次查出的)/;
const JIRA_BUG_ANALYSIS_CONTINUE_HINTS = /^(开始|开始分析|开始进行分析|继续|继续分析|继续\/恢复|恢复|恢复分析|重新分析|重新跑|重跑|再分析|进行分析)$/i;

function shouldUseJiraOperationIntent(text) {
  const source = String(text || '');
  if (!JIRA_OPERATION_INTENT_HINTS.test(source)) {
    return false;
  }
  return JIRA_ISSUE_KEY_PATTERN.test(source) || JIRA_CONTEXT_REFERENCE_HINTS.test(source);
}

function hasRecentJiraBugContext(historyMessages = []) {
  return historyMessages
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .slice(-12)
    .some((message) => JIRA_ISSUE_KEY_PATTERN.test(String(message.text || '')) && /(BUG|bug|分析|工程级|评论|Run ID|bug-run-)/i.test(String(message.text || '')));
}

function shouldContinueJiraBugAnalysisFromContext(text, historyMessages = []) {
  const source = String(text || '').trim();
  return JIRA_BUG_ANALYSIS_CONTINUE_HINTS.test(source) && hasRecentJiraBugContext(historyMessages);
}

const JIRA_DELETE_VERBS = /(删除|删掉|清空|清除|移除|清理|撤回)/;
const JIRA_AI_COMMENT_HINT = /(AI\s*评论|AI\s*分析\s*评论|白泽\s*评论|白泽\s*AI|AI\s*分析|AI\s*comment|baize\s*comment)/i;
const JIRA_OWN_COMMENT_HINT = /(我(?:的|发的|写的)?\s*评论|白泽(?:的|发的|写的)?\s*评论|baize\s*的?评论)/i;

function extractJiraDeleteOwnCommentsRequest(text) {
  const source = String(text || '');
  if (!JIRA_DELETE_VERBS.test(source)) {
    return null;
  }
  const mentionsComment = /(评论|备注|comment)/i.test(source);
  if (!mentionsComment) {
    return null;
  }
  if (!JIRA_AI_COMMENT_HINT.test(source) && !JIRA_OWN_COMMENT_HINT.test(source)) {
    return null;
  }
  const issueKeys = [];
  const seen = new Set();
  const re = /\b([A-Z][A-Z0-9_]{0,15}-\d+)\b/g;
  let match;
  while ((match = re.exec(source))) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      issueKeys.push(match[1]);
    }
  }
  return {
    issueKeys,
    onlyAiPrefix: JIRA_AI_COMMENT_HINT.test(source)
  };
}

function shouldDeleteOwnJiraComments(text) {
  return Boolean(extractJiraDeleteOwnCommentsRequest(text));
}

const JIRA_UPDATE_VERBS = /(修改|更新|改成|改为|改一下|改了|调整|设置|设成|设为|priority|优先级|描述|标题|标签|分配|负责人|经办人)/i;
const JIRA_TRANSITION_VERBS = /(切到|转到|改成|改为|状态|进入|完成|关闭|开始|reopen|重新打开|准备好)/i;
const JIRA_DELETE_ISSUE_VERBS = /(删除|删掉|销毁|删).{0,4}(单|issue|jira)/i;

function shouldOperateOnJiraIssue(text, verbsRe) {
  const source = String(text || '');
  if (!JIRA_ISSUE_KEY_PATTERN.test(source)) {
    return false;
  }
  if (extractJiraCommentRequest(source) || extractJiraDeleteOwnCommentsRequest(source)) {
    return false;
  }
  return verbsRe.test(source);
}

function shouldUpdateJiraIssue(text) {
  return shouldOperateOnJiraIssue(text, JIRA_UPDATE_VERBS);
}

function shouldTransitionJiraIssue(text) {
  const source = String(text || '');
  if (!JIRA_ISSUE_KEY_PATTERN.test(source)) {
    return false;
  }
  if (extractJiraCommentRequest(source) || extractJiraDeleteOwnCommentsRequest(source)) {
    return false;
  }
  if (!/状态|切到|转到|进入|完成|关闭|开始处理|reopen|重新打开/.test(source)) {
    return false;
  }
  return true;
}

function shouldDeleteJiraIssue(text) {
  const source = String(text || '');
  if (!JIRA_ISSUE_KEY_PATTERN.test(source)) {
    return false;
  }
  if (extractJiraDeleteOwnCommentsRequest(source)) {
    return false;
  }
  return JIRA_DELETE_ISSUE_VERBS.test(source) && !/评论|备注|comment/i.test(source);
}

function extractJiraQuery(text) {
  const assigneeMatch = text.match(/([一-龥A-Za-z0-9_.-]+)的[^，。\n]*(?:jira|Jira|JIRA)[^，。\n]*(?:需求单|issue|任务)/);
  const statusMatch = text.match(/状态(?:是|为)?[「“\"']?([^，。\n」”\"']+)/);
  return {
    assignee: assigneeMatch ? assigneeMatch[1].replace(/^(查询|拉取|筛选|分析)/, '') : undefined,
    status: statusMatch ? statusMatch[1].trim() : undefined
  };
}

function formatJiraAnalysisReply(result) {
  if (result && result.requiresUserInput) {
    const supplement = result.supplement || {};
    const choices = Array.isArray(supplement.choices) && supplement.choices.length > 0
      ? supplement.choices.map((choice, index) => `${index + 1}. ${choice.label || choice.value}`).join('\n')
      : null;
    return ['白泽：Jira 查询需要补充条件。', supplement.prompt, choices].filter(Boolean).join('\n');
  }
  if (result && result.notRecoverable) {
    const recovery = result.jiraSearchRecovery || {};
    return ['白泽：暂时无法完成这次 Jira 查询。', recovery.summary, recovery.reason].filter(Boolean).join('\n');
  }
  const lines = result.issues.slice(0, 10).map((issue, index) => `${index + 1}. ${issue.key} ${issue.summary}（${issue.status || '未设置状态'}，${issue.assignee || '未分配'}）`);
  const resolvedUsers = Array.isArray(result.resolvedUsers) && result.resolvedUsers.length > 0
    ? `已解析 Jira 用户：${result.resolvedUsers.join('、')}`
    : null;
  const recoveryNote = result && result.jiraSearchRecovery && result.jiraSearchRecovery.status === 'retry_succeeded'
    ? '已根据 Jira 错误自动修正查询。'
    : null;
  return ['白泽：已拉取 Jira 需求单并完成状态分析。', recoveryNote, resolvedUsers, result.analysis.summary, ...lines].filter(Boolean).join('\n');
}

function formatJiraCommentReply(issueKey, body) {
  const trimmed = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return `白泽：已直接写入 ${issueKey} 评论：${trimmed}`;
}

function formatJiraCommentFailedReply(issueKey, errorMessage) {
  return `白泽：写入 ${issueKey} 评论失败：${errorMessage}`;
}

async function executeJiraAddComment(message, { baizeRoot, fetchImpl }) {
  const request = extractJiraCommentRequest(message.text);
  if (!request) {
    return { reply: '白泽：没有解析到要评论的 Jira 单或评论内容。' };
  }
  try {
    const config = await getJiraConfig({ baizeRoot });
    await addJiraComment(config, request.issueKey, request.body, { fetchImpl });
    return { reply: formatJiraCommentReply(request.issueKey, request.body), issueKey: request.issueKey };
  } catch (error) {
    return { reply: formatJiraCommentFailedReply(request.issueKey, error.publicMessage || error.message || '未知错误') };
  }
}

async function executeJiraSummarizedComment(operationIntent, { baizeRoot, fetchImpl }) {
  const issueKey = operationIntent && operationIntent.issueKey;
  const body = operationIntent && operationIntent.body;
  if (!issueKey || !body) {
    return { reply: '白泽：Claude Code 没有生成可用的 Jira 评论草稿。', issueKey, body, sources: [] };
  }
  try {
    const config = await getJiraConfig({ baizeRoot });
    await addJiraComment(config, issueKey, body, { fetchImpl });
    return {
      reply: `白泽：已根据分析向 ${issueKey} 写入评论：${body.length > 200 ? `${body.slice(0, 200)}…` : body}`,
      issueKey,
      body,
      sources: Array.isArray(operationIntent.sources) ? operationIntent.sources : []
    };
  } catch (error) {
    return {
      reply: formatJiraCommentFailedReply(issueKey, error.publicMessage || error.message || '未知错误'),
      issueKey,
      body,
      sources: Array.isArray(operationIntent.sources) ? operationIntent.sources : [],
      failed: true
    };
  }
}

async function runPluginWriteThroughGateway({
  plugin = 'jira',
  kind,
  issueKeys,
  triggerSource = 'client',
  intent,
  message,
  baizeRoot,
  fetchImpl,
  emit,
  emitActivity,
  executor,
  claudeCodeRunner
}) {
  const audit = await auditPluginOperation({ plugin, kind, issueKeys, triggerSource, baizeRoot });
  let auditId = null;
  if (audit.decision === 'require_confirmation') {
    const pending = await createPendingAudit({
      plugin,
      kind,
      triggerSource,
      intent,
      audit,
      requester: {
        conversationId: message && message.conversationId,
        clientId: message && message.clientId,
        userId: message && message.userId,
        platform: message && message.platform
      }
    }, { baizeRoot });
    auditId = pending.auditId;
  }
  if (typeof emit === 'function') {
    emit({
      type: 'jira_audit_required',
      auditId,
      plugin,
      kind,
      perIssue: audit.perIssue,
      decision: audit.decision,
      summary: audit.summary,
      triggerSource,
      expiresAt: auditId ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null
    });
  }

  if (audit.decision === 'deny') {
    const denyReasons = audit.perIssue.filter((item) => item.decision === 'deny').map((item) => `${item.issueKey}：${item.reason}`).join('；');
    return { reply: `白泽：审计官拒绝执行 ${kind}。${denyReasons ? '原因：' + denyReasons : audit.summary}`, audit };
  }

  if (audit.decision === 'require_confirmation') {
    const lines = [
      `白泽：${kind} 已提交审计，需要在客户端审计卡上点击允许执行后才会真正写入。`,
      audit.perIssue.filter((item) => item.decision === 'require_confirmation').map((item) => `- ${item.issueKey}（${item.aiCreated ? 'AI 创建' : '非 AI 单'}）：${item.reason}`).join('\n'),
      audit.perIssue.filter((item) => item.decision === 'deny').length > 0
        ? '以下单审计官已拒绝，不会执行：\n' + audit.perIssue.filter((item) => item.decision === 'deny').map((item) => `- ${item.issueKey}：${item.reason}`).join('\n')
        : null
    ].filter(Boolean);
    return { reply: lines.join('\n\n'), audit, auditId, awaitingConfirmation: true };
  }

  // allow
  if (typeof executor !== 'function') {
    return { reply: '白泽：审计官放行，但服务端未注册该意图的执行器。', audit };
  }
  if (typeof emitActivity === 'function') {
    emitActivity('plugin_gateway_allow', `审计官放行，开始执行 ${kind}。`);
  }
  return executePluginIntentWithRecovery({
    plugin,
    kind,
    audit,
    intent,
    baizeRoot,
    fetchImpl,
    emit,
    emitActivity,
    executor,
    claudeCodeRunner
  });
}

async function executePluginIntentWithRecovery({
  plugin,
  kind,
  audit,
  intent,
  baizeRoot,
  fetchImpl,
  emit,
  emitActivity,
  executor,
  claudeCodeRunner,
  maxRecoveryAttempts = 2
}) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= maxRecoveryAttempts) {
    attempt += 1;
    let execResult;
    let executorError;
    try {
      execResult = await executor({ intent, audit, baizeRoot, fetchImpl, emit });
    } catch (error) {
      executorError = error;
    }
    if (!executorError && execResult && execResult.failed !== true) {
      return { ...execResult, audit, decision: 'allow', recovered: attempt > 1 };
    }
    const errorMessage = executorError
      ? (executorError.publicMessage || executorError.message || '未知错误')
      : (execResult && (execResult.error || execResult.reply) ? (execResult.error || execResult.reply) : '执行失败');
    lastError = errorMessage;
    if (attempt > maxRecoveryAttempts) {
      break;
    }
    if (typeof emitActivity === 'function') {
      emitActivity('jira_write_error_analysis', `白泽正在让 Claude Code 分析 ${kind} 写入失败。`);
    }
    let recovery;
    try {
      recovery = await runClaudeCodeTask({
        message: { text: `请分析 ${kind} 写入失败并给出安全恢复建议。` },
        permissionMode: 'jira_write_error_analysis',
        runner: claudeCodeRunner,
        writeFailure: {
          kind,
          intent: sanitizeIntentForRecovery(intent),
          error: errorMessage,
          attempt,
          maxAttempts: maxRecoveryAttempts
        }
      });
    } catch {
      recovery = {
        status: 'not_recoverable',
        analyzedBy: 'server',
        summary: 'Claude Code 无法给出可用的写入恢复方案。',
        reason: errorMessage,
        action: { id: 'not_recoverable', label: '无法自动恢复', requiresConfirmation: false }
      };
    }
    if (typeof emit === 'function') {
      emit({ type: 'jira_write_recovery', plugin, kind, attempt, recovery });
    }
    if (!recovery || recovery.status === 'not_recoverable') {
      return {
        reply: `白泽：${kind} 写入失败：${errorMessage}。Claude Code 判断不可自动恢复。${recovery && recovery.reason ? '原因：' + recovery.reason : ''}`,
        audit,
        decision: 'allow',
        recovery,
        failed: true
      };
    }
    if (recovery.status === 'needs_user_input') {
      return {
        reply: `白泽：${kind} 写入失败：${errorMessage}。Claude Code 需要用户补充：${recovery.summary || ''}`,
        audit,
        decision: 'allow',
        recovery,
        requiresClientInput: true
      };
    }
    // retry_available: 再循环一次
  }
  return {
    reply: `白泽：${kind} 写入失败：${lastError}（已尝试 ${maxRecoveryAttempts} 次自动恢复）。`,
    audit,
    decision: 'allow',
    failed: true
  };
}

function sanitizeIntentForRecovery(intent) {
  if (!intent || typeof intent !== 'object') {
    return null;
  }
  const safe = {};
  for (const key of ['kind', 'issueKey', 'issueKeys', 'transition', 'filterScope']) {
    if (intent[key] !== undefined) {
      safe[key] = intent[key];
    }
  }
  if (intent.fields && typeof intent.fields === 'object') {
    safe.fieldNames = Object.keys(intent.fields).slice(0, 30);
  }
  if (intent.body) {
    safe.bodyPreview = String(intent.body).slice(0, 200);
  }
  if (Array.isArray(intent.entries)) {
    safe.entries = intent.entries.slice(0, 20).map((entry) => ({ issueKey: entry.issueKey, bodyPreview: String(entry.body || '').slice(0, 80) }));
  }
  if (Array.isArray(intent.targets)) {
    safe.targets = intent.targets.slice(0, 20).map((target) => ({ issueKey: target.issueKey, commentIds: target.commentIds }));
  }
  return safe;
}

async function executeJiraAddCommentSimple({ intent, baizeRoot, fetchImpl }) {
  const issueKey = intent && intent.issueKey;
  const body = intent && intent.body;
  if (!issueKey || !body) {
    return { reply: '白泽：没有解析到要评论的 Jira 单或评论内容。' };
  }
  try {
    const config = await getJiraConfig({ baizeRoot });
    await addJiraComment(config, issueKey, body, { fetchImpl });
    return { reply: formatJiraCommentReply(issueKey, body), issueKey };
  } catch (error) {
    return { reply: formatJiraCommentFailedReply(issueKey, error.publicMessage || error.message || '未知错误'), failed: true };
  }
}

async function executeJiraSummarizedCommentSimple({ intent, baizeRoot, fetchImpl }) {
  return executeJiraSummarizedComment(intent, { baizeRoot, fetchImpl });
}

async function executeJiraBulkAddCommentSimple({ intent, baizeRoot, fetchImpl, emit }) {
  return executeJiraBulkAddComment(intent, {
    baizeRoot,
    fetchImpl,
    onIssueResult: (result) => emit && emit({ type: 'jira_comment_result', ...result })
  });
}

function getBugAnalysisIssueKeys(operationIntent = {}) {
  if (Array.isArray(operationIntent.issueKeys)) {
    return operationIntent.issueKeys;
  }
  if (Array.isArray(operationIntent.entries)) {
    return operationIntent.entries.map((entry) => entry && entry.issueKey).filter(Boolean);
  }
  return [];
}

async function runEngineeringBugAnalysisForIssues({ operationIntent, message, baizeRoot, fetchImpl, claudeCodeRunner, emitActivity }) {
  const issueKeys = getBugAnalysisIssueKeys(operationIntent);
  if (typeof emitActivity === 'function') {
    emitActivity('jira_bug_analysis_workspace', `正在创建或恢复工程级 BUG 分析后台任务，共 ${issueKeys.length} 个 Jira Bug 单。`);
  }
  const result = await createOrResumeBugAnalysisRun({
    issueKeys,
    clientId: message.clientId,
    userId: message.userId,
    conversationId: message.conversationId
  }, { baizeRoot, fetchImpl, claudeCodeRunner });
  const run = result.run;
  return {
    reply: [
      `白泽：已${result.reused ? '恢复' : '创建'}工程级 BUG 分析后台任务。`,
      `Run ID：${run.id}`,
      `共 ${run.total} 个 BUG，当前状态：${run.status}。`,
      '客户端会轮询分析进度；生成评论草稿后，请在 BUG 分析卡片中逐条确认是否写入 Jira。'
    ].join('\n'),
    run,
    bugAnalysisRun: run,
    reused: result.reused,
    enqueued: result.enqueued,
    alreadyRunning: result.alreadyRunning
  };
}

async function executeJiraUpdateIssue({ intent, baizeRoot, fetchImpl }) {
  const issueKey = intent && intent.issueKey;
  const fields = intent && intent.fields;
  if (!issueKey || !fields || Object.keys(fields).length === 0) {
    return { reply: '白泽：缺少要更新的 Jira 单或字段。' };
  }
  const config = await getJiraConfig({ baizeRoot });
  try {
    await updateJiraIssue(config, issueKey, fields, { fetchImpl });
    return { reply: `白泽：${issueKey} 已按草稿更新。`, issueKey };
  } catch (error) {
    return { reply: `白泽：更新 ${issueKey} 失败：${error.publicMessage || error.message || '未知错误'}`, failed: true };
  }
}

async function executeJiraTransitionIssue({ intent, baizeRoot, fetchImpl }) {
  const issueKey = intent && intent.issueKey;
  const transition = intent && intent.transition;
  if (!issueKey || !transition) {
    return { reply: '白泽：缺少要切换状态的 Jira 单或目标 transition。' };
  }
  const config = await getJiraConfig({ baizeRoot });
  try {
    await transitionJiraIssue(config, issueKey, transition, { fetchImpl });
    return { reply: `白泽：${issueKey} 已切换状态（${transition.id || transition.name}）。`, issueKey };
  } catch (error) {
    return { reply: `白泽：切换 ${issueKey} 状态失败：${error.publicMessage || error.message || '未知错误'}`, failed: true };
  }
}

async function executeJiraDeleteIssue({ intent, audit, baizeRoot, fetchImpl, emit }) {
  const issueKeys = Array.isArray(intent && intent.issueKeys) ? intent.issueKeys : [];
  if (issueKeys.length === 0) {
    return { reply: '白泽：没有要删除的 Jira 单。' };
  }
  const config = await getJiraConfig({ baizeRoot });
  const deleted = [];
  const failed = [];
  for (const issueKey of issueKeys) {
    const audited = audit && Array.isArray(audit.perIssue) ? audit.perIssue.find((item) => item.issueKey === issueKey) : null;
    if (audited && audited.decision !== 'allow') {
      failed.push({ issueKey, error: audited.reason || '审计官未放行。' });
      if (typeof emit === 'function') {
        emit({ type: 'jira_delete_issue_result', issueKey, status: 'skipped', error: audited.reason });
      }
      continue;
    }
    try {
      await deleteJiraIssue(config, issueKey, { fetchImpl });
      deleted.push(issueKey);
      if (typeof emit === 'function') {
        emit({ type: 'jira_delete_issue_result', issueKey, status: 'ok' });
      }
    } catch (error) {
      const message = error.publicMessage || error.message || '未知错误';
      failed.push({ issueKey, error: message });
      if (typeof emit === 'function') {
        emit({ type: 'jira_delete_issue_result', issueKey, status: 'failed', error: message });
      }
    }
  }
  const summary = failed.length === 0
    ? `白泽：已删除 ${deleted.length} 个 Jira 单：${deleted.join('、')}。`
    : `白泽：删除完成，成功 ${deleted.length} 个（${deleted.join('、') || '无'}），失败 ${failed.length} 个（${failed.map((item) => `${item.issueKey}：${item.error}`).join('；')}）。`;
  return { reply: summary, deleted, failed };
}

async function executeJiraDeleteComment({ intent, audit, baizeRoot, fetchImpl, emit }) {
  const targets = Array.isArray(intent && intent.targets) ? intent.targets : [];
  const filterScope = (intent && intent.filterScope) || 'self_ai_prefix';
  if (targets.length === 0) {
    return { reply: '白泽：没有要删评论的目标。' };
  }
  const config = await getJiraConfig({ baizeRoot });
  const authorIdentifiers = filterScope === 'any' ? null : [config.username, config.email].filter(Boolean);
  if (filterScope !== 'any' && (!authorIdentifiers || authorIdentifiers.length === 0)) {
    return { reply: '白泽：没有识别到当前 Jira 账号身份，不能安全删除评论。' };
  }
  const predicate = filterScope === 'self_ai_prefix'
    ? (comment) => /^\s*(?:【AI\s*分析|【AI\b|AI\s*分析)/i.test(String(comment && comment.body || ''))
    : (filterScope === 'any' ? () => true : undefined);
  const perIssue = [];
  let totalDeleted = 0;
  let totalFailed = 0;
  for (const target of targets) {
    const audited = audit && Array.isArray(audit.perIssue) ? audit.perIssue.find((item) => item.issueKey === target.issueKey) : null;
    if (audited && audited.decision !== 'allow') {
      perIssue.push({ issueKey: target.issueKey, deleted: 0, failed: 0, skipped: true, reason: audited.reason });
      continue;
    }
    try {
      const result = await deleteJiraAuthorComments(
        config,
        target.issueKey,
        authorIdentifiers || ['__match-any__'],
        { fetchImpl, predicate }
      );
      totalDeleted += result.deleted.length;
      totalFailed += result.failed.length;
      perIssue.push({ issueKey: target.issueKey, deleted: result.deleted.length, failed: result.failed.length });
      if (typeof emit === 'function') {
        emit({ type: 'jira_comment_delete_result', issueKey: target.issueKey, deleted: result.deleted.length, failed: result.failed.length });
      }
    } catch (error) {
      const message = error.publicMessage || error.message || '未知错误';
      perIssue.push({ issueKey: target.issueKey, deleted: 0, failed: 1, error: message });
      totalFailed += 1;
      if (typeof emit === 'function') {
        emit({ type: 'jira_comment_delete_result', issueKey: target.issueKey, deleted: 0, failed: 1, error: message });
      }
    }
  }
  const filterLabel = filterScope === 'any' ? '任意作者' : (filterScope === 'self' ? '白泽账号' : '【AI 分析】前缀');
  const summary = `白泽：已扫描 ${targets.length} 个 Jira 单（仅删 ${filterLabel} 的评论），删除 ${totalDeleted} 条${totalFailed > 0 ? `，失败 ${totalFailed} 条` : ''}。`;
  return { reply: summary, perIssue, totalDeleted, totalFailed };
}

async function executeJiraDeleteCommentAudited(operationIntent, { baizeRoot, fetchImpl, triggerSource = 'client', onIssueResult, emit } = {}) {
  const targets = Array.isArray(operationIntent && operationIntent.targets) ? operationIntent.targets : [];
  const filterScope = operationIntent && operationIntent.filterScope ? operationIntent.filterScope : 'self_ai_prefix';
  if (targets.length === 0) {
    return { reply: '白泽：Claude Code 没有生成可执行的删评论目标。', audit: null, perIssue: [] };
  }
  const audit = await auditPluginOperation({
    plugin: 'jira',
    kind: 'jira_delete_comment',
    issueKeys: targets.map((target) => target.issueKey),
    triggerSource,
    baizeRoot
  });
  if (typeof emit === 'function') {
    emit({ type: 'jira_audit_required', auditId: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: 'jira_delete_comment', filterScope, perIssue: audit.perIssue, decision: audit.decision, summary: audit.summary });
  }
  if (audit.decision === 'deny') {
    const denyReasons = audit.perIssue.filter((item) => item.decision === 'deny').map((item) => `${item.issueKey}：${item.reason}`).join('；');
    return {
      reply: `白泽：审计官拒绝执行删评论。${denyReasons ? '原因：' + denyReasons : audit.summary}`,
      audit,
      perIssue: []
    };
  }
  if (audit.decision === 'require_confirmation') {
    const denyKeys = audit.perIssue.filter((item) => item.decision === 'deny').map((item) => `${item.issueKey}（${item.reason}）`);
    const confirmKeys = audit.perIssue.filter((item) => item.decision === 'require_confirmation').map((item) => `${item.issueKey}（${item.reason}）`);
    const allowKeys = audit.perIssue.filter((item) => item.decision === 'allow').map((item) => item.issueKey);
    const lines = [
      '白泽：以下删评论操作需要审计确认，请在客户端审计卡上选择是否执行。',
      confirmKeys.length > 0 ? `等待确认：\n- ${confirmKeys.join('\n- ')}` : null,
      allowKeys.length > 0 ? `定时任务可直接放行：\n- ${allowKeys.join('\n- ')}` : null,
      denyKeys.length > 0 ? `审计官拒绝：\n- ${denyKeys.join('\n- ')}` : null
    ].filter(Boolean);
    return {
      reply: lines.join('\n\n'),
      audit,
      perIssue: [],
      requiresClientConfirmation: true
    };
  }

  // decision === 'allow'：通常是 scheduled 触发，也兼容 read-only 场景
  const config = await getJiraConfig({ baizeRoot });
  const authorIdentifiers = filterScope === 'any' ? null : [config.username, config.email].filter(Boolean);
  if (filterScope !== 'any' && (!authorIdentifiers || authorIdentifiers.length === 0)) {
    return {
      reply: '白泽：没有识别到当前 Jira 账号身份，不能安全删除评论。',
      audit,
      perIssue: []
    };
  }
  const predicate = filterScope === 'self_ai_prefix'
    ? (comment) => /^\s*(?:【AI\s*分析|【AI\b|AI\s*分析)/i.test(String(comment && comment.body || ''))
    : undefined;

  const perIssue = [];
  let totalDeleted = 0;
  let totalFailed = 0;
  for (const target of targets) {
    const audited = audit.perIssue.find((item) => item.issueKey === target.issueKey);
    if (audited && audited.decision !== 'allow') {
      perIssue.push({ issueKey: target.issueKey, deleted: 0, failed: 0, skipped: true, reason: audited.reason });
      continue;
    }
    try {
      const result = await deleteJiraAuthorComments(
        config,
        target.issueKey,
        authorIdentifiers || ['__match-any__'],
        {
          fetchImpl,
          predicate: filterScope === 'any'
            ? () => true
            : predicate
        }
      );
      totalDeleted += result.deleted.length;
      totalFailed += result.failed.length;
      perIssue.push({ issueKey: target.issueKey, deleted: result.deleted.length, failed: result.failed.length, matched: result.matched, scanned: result.scanned });
      if (typeof onIssueResult === 'function') {
        onIssueResult({ issueKey: target.issueKey, deleted: result.deleted.length, failed: result.failed.length, matched: result.matched, scanned: result.scanned });
      }
    } catch (error) {
      const message = error.publicMessage || error.message || '未知错误';
      perIssue.push({ issueKey: target.issueKey, deleted: 0, failed: 1, error: message });
      totalFailed += 1;
      if (typeof onIssueResult === 'function') {
        onIssueResult({ issueKey: target.issueKey, deleted: 0, failed: 1, error: message });
      }
    }
  }
  const filterLabel = filterScope === 'any' ? '任意作者' : (filterScope === 'self' ? '白泽账号' : '【AI 分析】前缀');
  const summary = `白泽：审计官放行，已扫描 ${targets.length} 个 Jira 单（仅删 ${filterLabel} 的评论），删除 ${totalDeleted} 条${totalFailed > 0 ? `，失败 ${totalFailed} 条` : ''}。`;
  return { reply: summary, audit, perIssue, totalDeleted, totalFailed };
}

async function executeJiraDeleteOwnComments(intent, { baizeRoot, fetchImpl, claudeCodeRunner, onIssueResult } = {}) {
  const config = await getJiraConfig({ baizeRoot });
  const authorIdentifiers = [config.username, config.email].filter(Boolean);
  if (authorIdentifiers.length === 0) {
    return { reply: '白泽：没有识别到当前 Jira 账号身份，不能安全删除评论。', perIssue: [] };
  }
  const onlyAiPrefix = Boolean(intent && intent.onlyAiPrefix);
  const predicate = onlyAiPrefix
    ? (comment) => /^\s*(?:【AI\s*分析|【AI\b|AI\s*分析)/i.test(String(comment && comment.body || ''))
    : undefined;

  let issueKeys = Array.isArray(intent && intent.targetIssueKeys) ? intent.targetIssueKeys.slice() : [];
  let resolvedSearch = null;
  if (issueKeys.length === 0) {
    try {
      const jiraResult = await searchAndAnalyzeJira(extractJiraQuery(intent && intent.originalText || '') || {}, { baizeRoot, fetchImpl, claudeCodeRunner });
      if (jiraResult && Array.isArray(jiraResult.issues)) {
        issueKeys = jiraResult.issues.map((issue) => issue.key).filter(Boolean);
        resolvedSearch = jiraResult;
      }
    } catch {
      // ignore, will fall through to no-target reply
    }
  }
  if (issueKeys.length === 0) {
    return {
      reply: '白泽：没有定位到要清理评论的 Jira 单。请直接给出 BUG 单号，或先让我搜索一下（例如：曾浩然的未开始 BUG 单）。',
      perIssue: [],
      resolvedSearch
    };
  }
  if (issueKeys.length > 100) {
    issueKeys = issueKeys.slice(0, 100);
  }

  const perIssue = [];
  let totalDeleted = 0;
  let totalFailed = 0;
  for (const issueKey of issueKeys) {
    try {
      const result = await deleteJiraAuthorComments(config, issueKey, authorIdentifiers, { fetchImpl, predicate });
      totalDeleted += result.deleted.length;
      totalFailed += result.failed.length;
      perIssue.push({ issueKey, deleted: result.deleted.length, failed: result.failed.length, matched: result.matched, scanned: result.scanned, errors: result.failed });
      if (typeof onIssueResult === 'function') {
        onIssueResult({ issueKey, deleted: result.deleted.length, failed: result.failed.length, matched: result.matched, scanned: result.scanned });
      }
    } catch (error) {
      const message = error.publicMessage || error.message || '未知错误';
      perIssue.push({ issueKey, deleted: 0, failed: 0, matched: 0, scanned: 0, errors: [{ error: message }] });
      totalFailed += 1;
      if (typeof onIssueResult === 'function') {
        onIssueResult({ issueKey, deleted: 0, failed: 1, error: message });
      }
    }
  }

  const filterLabel = onlyAiPrefix ? '【AI 分析】前缀' : '白泽账号';
  const summary = `白泽：已扫描 ${issueKeys.length} 个 Jira 单（仅删 ${filterLabel} 的评论），删除 ${totalDeleted} 条${totalFailed > 0 ? `，失败 ${totalFailed} 条` : ''}。`;
  return { reply: summary, perIssue, totalDeleted, totalFailed, resolvedSearch, issueKeys };
}

async function executeJiraBulkAddComment(operationIntent, { baizeRoot, fetchImpl, onIssueResult } = {}) {
  const entries = Array.isArray(operationIntent && operationIntent.entries) ? operationIntent.entries : [];
  if (entries.length === 0) {
    return { reply: '白泽：Claude Code 没有生成可用的 Jira 批量评论草稿。', entries: [], succeeded: [], failed: [] };
  }
  const config = await getJiraConfig({ baizeRoot });
  const succeeded = [];
  const failed = [];
  for (const entry of entries) {
    try {
      await addJiraComment(config, entry.issueKey, entry.body, { fetchImpl });
      succeeded.push(entry.issueKey);
      if (typeof onIssueResult === 'function') {
        onIssueResult({ issueKey: entry.issueKey, status: 'ok' });
      }
    } catch (error) {
      const errorMessage = error.publicMessage || error.message || '未知错误';
      failed.push({ issueKey: entry.issueKey, error: errorMessage });
      if (typeof onIssueResult === 'function') {
        onIssueResult({ issueKey: entry.issueKey, status: 'failed', error: errorMessage });
      }
    }
  }
  const summary = failed.length === 0
    ? `白泽：已为 ${succeeded.length} 个 Jira 单各自写入对应评论（${succeeded.join('、')}）。`
    : `白泽：批量写入完成，成功 ${succeeded.length} 个（${succeeded.join('、') || '无'}），失败 ${failed.length} 个（${failed.map((item) => `${item.issueKey}：${item.error}`).join('；')}）。`;
  return {
    reply: summary,
    entries,
    succeeded,
    failed
  };
}

function formatJiraCreateReply(operation) {
  return `白泽：已解析 ${operation.draftImport.count} 个 Jira 需求单草稿，请确认是否创建。`;
}

function formatJiraCreatedReply(operation) {
  const createdIssues = Array.isArray(operation.createdIssues) ? operation.createdIssues : [];
  const keys = createdIssues.map((issue) => issue.key).filter(Boolean).join('、');
  return keys ? `白泽：Jira 单创建成功：${keys}` : '白泽：Jira 单创建成功。';
}

function formatJiraRecoveryRequiredReply(operation) {
  const recovery = operation.recovery || {};
  return `白泽：Jira 创建失败，已生成恢复选项：${recovery.summary || '请在客户端选择下一步。'}`;
}

function formatJiraRejectedReply() {
  return '白泽：已取消当前 Jira 创建草稿。';
}

function isJiraImportAttachment(attachment = {}) {
  return /\.(xlsx|xls|txt|csv)$/i.test(attachment.fileName || '');
}

async function getJiraImportAttachment(message, { baizeRoot } = {}) {
  for (const attachmentId of message.attachmentIds || []) {
    try {
      const attachment = await getAttachment(attachmentId, { baizeRoot });
      if (isJiraImportAttachment(attachment)) {
        return attachment;
      }
    } catch {
    }
  }

  if (message.conversationId) {
    const attachments = await listConversationAttachments(message.conversationId, { baizeRoot });
    return attachments.find(isJiraImportAttachment) || null;
  }

  return null;
}

function getAttachmentSummary(attachment = {}) {
  if (attachment.analysis && typeof attachment.analysis.summary === 'string') {
    return attachment.analysis.summary;
  }
  if (attachment.memory && typeof attachment.memory.summary === 'string') {
    return attachment.memory.summary;
  }
  if (typeof attachment.summary === 'string') {
    return attachment.summary;
  }
  return '';
}

function toAttachmentContext(attachment = {}) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    type: attachment.type,
    size: attachment.size,
    storagePath: attachment.storagePath,
    readPath: attachment.storagePath ? attachment.storagePath.replace(/\\/g, '/') : undefined,
    summary: getAttachmentSummary(attachment),
    semanticExtraction: attachment.semanticExtraction
  };
}

async function enrichAttachmentContext(attachment, { baizeRoot } = {}) {
  if (!attachment || attachment.type !== 'spreadsheet') {
    return attachment;
  }
  try {
    return {
      ...attachment,
      semanticExtraction: await ensureSpreadsheetSemanticExtraction(attachment, { baizeRoot })
    };
  } catch (error) {
    return {
      ...attachment,
      semanticExtractionError: error.publicMessage || error.message || '表格高保真抽取失败。'
    };
  }
}

async function collectMessageAttachmentContext(message, { baizeRoot } = {}) {
  const byId = new Map();
  for (const attachmentId of message.attachmentIds || []) {
    try {
      const attachment = await getAttachment(attachmentId, { baizeRoot });
      if (attachment && attachment.id) {
        byId.set(attachment.id, attachment);
      }
    } catch {
    }
  }

  if (byId.size === 0 && message.conversationId) {
    const attachments = await listConversationAttachments(message.conversationId, { baizeRoot });
    for (const attachment of attachments) {
      if (attachment && attachment.id) {
        byId.set(attachment.id, attachment);
      }
    }
  }

  const attachments = await Promise.all(Array.from(byId.values()).slice(0, 10).map((attachment) => enrichAttachmentContext(attachment, { baizeRoot })));
  return attachments.map(toAttachmentContext);
}

async function createJiraImportDraftsFromXlsx(message, attachment, { baizeRoot, jiraDraftTextGenerator, onTiming } = {}) {
  const buffer = await fs.readFile(attachment.storagePath);
  const generatedText = await jiraDraftTextGenerator({
    fileName: attachment.fileName,
    buffer,
    userText: getUserInstructionText(message.text),
    baizeRoot,
    onTiming
  });
  return createJiraImportDrafts({
    fileName: `${attachment.fileName}.claude.txt`,
    text: generatedText
  }, { baizeRoot });
}

async function createJiraImportDraftsFromMessage(message, attachment, { baizeRoot, jiraDraftTextGenerator, onTiming } = {}) {
  if (!attachment) {
    return createJiraImportDrafts({ fileName: 'jira-import.txt', text: message.text }, { baizeRoot });
  }
  if (/\.xlsx?$/i.test(attachment.fileName || '')) {
    return createJiraImportDraftsFromXlsx(message, attachment, { baizeRoot, jiraDraftTextGenerator, onTiming });
  }
  return createJiraImportDrafts({ attachmentId: attachment.id }, { baizeRoot });
}

async function createJiraDraftOperationFromText(message, { baizeRoot, fetchImpl, jiraDraftTextGenerator = generateJiraDraftTextFromXlsx, onTiming } = {}) {
  const attachment = await getJiraImportAttachment(message, { baizeRoot });
  const draftImport = await createJiraImportDraftsFromMessage(message, attachment, { baizeRoot, jiraDraftTextGenerator, onTiming });
  return createJiraDraftOperationFromDrafts(message, {
    fileName: draftImport.fileName,
    drafts: draftImport.drafts,
    warnings: draftImport.warnings
  }, { baizeRoot, fetchImpl });
}

async function createJiraDraftOperationFromDrafts(message, draftImport, { baizeRoot, fetchImpl } = {}) {
  const sanitizedDrafts = draftImport.drafts.map((draft) => sanitizeJiraDraft(draft));
  const drafts = (await enrichJiraDrafts(sanitizedDrafts, { baizeRoot, fetchImpl })).map(sanitizeJiraDraft);
  return createJiraCreateOperation({
    clientId: message.clientId,
    userId: message.userId,
    conversationId: message.conversationId,
    fileName: draftImport.fileName || 'claude-code-jira-intent.json',
    count: drafts.length,
    drafts,
    warnings: drafts.some((draft) => !draft.projectKey)
      ? ['存在未配置项目 Key 的草稿，确认创建前需要补充项目。']
      : draftImport.warnings || []
  }, { baizeRoot });
}

function sanitizeMemoryResults(results) {
  return results.slice(0, 20).map((result) => ({
    category: result.category,
    line: result.line
  }));
}

async function measureTiming(timings, name, action) {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    timings[name] = Date.now() - startedAt;
  }
}

function getChatTimingLogPath(baizeRoot = paths.BAIZE_ROOT) {
  return path.join(baizeRoot, 'runtime', 'chat-timing.jsonl');
}

async function logChatTiming({ baizeRoot = paths.BAIZE_ROOT, conversationId, provider, status, timings }) {
  const entry = {
    loggedAt: new Date().toISOString(),
    conversationId: conversationId || null,
    provider: provider || null,
    status,
    ...timings
  };
  console.info('[baize:chat:timing]', JSON.stringify(entry));
  try {
    await appendJsonLine(getChatTimingLogPath(baizeRoot), entry, baizeRoot);
  } catch (error) {
    console.warn('[baize:chat:timing] failed to persist timing log:', error.code || '', error.message);
  }
}

async function collectShallowMemoryContext({ query, baizeRoot }) {
  const matchedResults = await searchShallowMemory({ q: query, baizeRoot });
  if (matchedResults.length > 0) {
    return sanitizeMemoryResults(matchedResults);
  }

  return sanitizeMemoryResults(await searchShallowMemory({ baizeRoot }));
}

async function resolveProvider({ provider, baizeRoot } = {}) {
  const claudeConfig = await getClaudeConfig({ baizeRoot });
  const selectedProvider = provider || claudeConfig.provider || (claudeConfig.enabled === true ? 'claude' : 'local_kb');
  if (!['local_kb', 'claude', 'claude_code'].includes(selectedProvider)) {
    throw validationError('Unsupported chat provider.');
  }

  return selectedProvider;
}

function routeJiraCreate(claudeCodeConfig) {
  const intent = { route: 'jira_create', confidence: 1, reason: 'Jira 创建请求', requiresConfirmation: true };
  return claudeCodeConfig.enabled === true
    ? { provider: 'claude_code_operation', intent, claudeCodeConfig }
    : { provider: 'jira_create', intent, claudeCodeConfig: null };
}

function routeJiraSearch(claudeCodeConfig) {
  const intent = { route: 'jira_search', confidence: 1, reason: 'Jira 查询请求', requiresConfirmation: false };
  return claudeCodeConfig.enabled === true
    ? { provider: 'claude_code_operation', intent, claudeCodeConfig }
    : { provider: 'jira', intent, claudeCodeConfig: null };
}

function routeJiraAddComment(claudeCodeConfig) {
  const intent = { route: 'jira_add_comment', confidence: 1, reason: 'Jira 评论写入', requiresConfirmation: false };
  return { provider: 'jira_add_comment', intent, claudeCodeConfig };
}

function routeJiraSummarizeThenComment(claudeCodeConfig, targetIssueKey) {
  const intent = { route: 'jira_summarize_then_comment', confidence: 1, reason: 'Jira 总结后写评论', requiresConfirmation: false, targetIssueKey };
  if (claudeCodeConfig && claudeCodeConfig.enabled === true) {
    return { provider: 'claude_code_operation', intent, claudeCodeConfig };
  }
  return { provider: 'jira_summarize_then_comment_unavailable', intent, claudeCodeConfig: null };
}

function routeJiraBulkAddComment(claudeCodeConfig, targetIssueKeys) {
  const intent = { route: 'jira_bulk_add_comment', confidence: 1, reason: 'Jira 批量评论写入', requiresConfirmation: false, targetIssueKeys };
  if (claudeCodeConfig && claudeCodeConfig.enabled === true) {
    return { provider: 'claude_code_operation', intent, claudeCodeConfig };
  }
  return { provider: 'jira_summarize_then_comment_unavailable', intent, claudeCodeConfig: null };
}

function routeJiraDeleteOwnComments(claudeCodeConfig, request, originalText) {
  const intent = {
    route: 'jira_delete_own_comments',
    confidence: 1,
    reason: 'Jira 评论删除',
    requiresConfirmation: false,
    targetIssueKeys: Array.isArray(request && request.issueKeys) ? request.issueKeys : [],
    onlyAiPrefix: Boolean(request && request.onlyAiPrefix),
    originalText: typeof originalText === 'string' ? originalText : ''
  };
  if (claudeCodeConfig && claudeCodeConfig.enabled === true) {
    return { provider: 'claude_code_operation', intent: { ...intent, route: 'jira_delete_comment' }, claudeCodeConfig };
  }
  return { provider: 'jira_delete_own_comments', intent, claudeCodeConfig };
}

function routeJiraIssueWrite(claudeCodeConfig, route) {
  const intent = { route, confidence: 1, reason: `Jira ${route}`, requiresConfirmation: true };
  if (claudeCodeConfig && claudeCodeConfig.enabled === true) {
    return { provider: 'claude_code_operation', intent, claudeCodeConfig };
  }
  return { provider: 'jira_summarize_then_comment_unavailable', intent, claudeCodeConfig: null };
}

function routeFromEngineeringIntent(intent, claudeCodeConfig, selectedProvider) {
  if (shouldUseClaudeCode(intent, claudeCodeConfig)) {
    return { provider: 'claude_code', intent, claudeCodeConfig };
  }

  if (intent.route === 'dangerous') {
    return { provider: 'claude_code_blocked', intent, claudeCodeConfig };
  }

  if (claudeCodeConfig.enabled === true && ['engineering_write', 'engineering_test'].includes(intent.route)) {
    return { provider: 'claude_code_pending', intent, claudeCodeConfig };
  }

  if (claudeCodeConfig.enabled === true && intent.route === 'ambiguous') {
    return { provider: 'claude_code_ambiguous', intent, claudeCodeConfig };
  }

  return { provider: selectedProvider, intent, claudeCodeConfig };
}

function resolveChatRouteWithLocalRules({ message, selectedProvider, claudeCodeConfig, attachments = [], historyMessages = [] }) {
  const isLogicAssertion = isLogicAssertionInstruction(message.text);

  if (shouldDeleteOwnJiraComments(message.text)) {
    return routeJiraDeleteOwnComments(claudeCodeConfig, extractJiraDeleteOwnCommentsRequest(message.text), message.text);
  }

  if (shouldDeleteJiraIssue(message.text)) {
    return routeJiraIssueWrite(claudeCodeConfig, 'jira_delete_issue');
  }

  if (shouldTransitionJiraIssue(message.text)) {
    return routeJiraIssueWrite(claudeCodeConfig, 'jira_transition_issue');
  }

  if (shouldUpdateJiraIssue(message.text)) {
    return routeJiraIssueWrite(claudeCodeConfig, 'jira_update_issue');
  }

  if (shouldAddJiraComment(message.text)) {
    return routeJiraAddComment(claudeCodeConfig);
  }

  if (shouldBulkAddJiraComment(message.text)) {
    const bulk = extractJiraBulkCommentRequest(message.text);
    return routeJiraBulkAddComment(claudeCodeConfig, bulk && bulk.issueKeys);
  }

  if (shouldSummarizeJiraComment(message.text)) {
    const target = extractJiraSummarizeCommentRequest(message.text);
    return routeJiraSummarizeThenComment(claudeCodeConfig, target && target.issueKey);
  }

  if (!isLogicAssertion && shouldCreateJiraIssue(message.text)) {
    return routeJiraCreate(claudeCodeConfig);
  }

  if (shouldUseJiraOperationIntent(message.text) || shouldContinueJiraBugAnalysisFromContext(message.text, historyMessages)) {
    const intent = { route: 'jira_operation_intent', confidence: 1, reason: 'Jira 操作意图交由 Claude Code 判断', requiresConfirmation: false };
    return claudeCodeConfig.enabled === true
      ? { provider: 'claude_code_operation', intent, claudeCodeConfig }
      : { provider: selectedProvider, intent, claudeCodeConfig };
  }

  if (shouldUseJiraPlugin(message.text)) {
    return routeJiraSearch(claudeCodeConfig);
  }

  const intent = classifyEngineeringIntent({ text: message.text });
  const engineeringRoute = routeFromEngineeringIntent(intent, claudeCodeConfig, selectedProvider);
  if (engineeringRoute.provider !== selectedProvider) {
    return engineeringRoute;
  }

  if (isOrdinaryChatIntent(message)) {
    return { provider: selectedProvider === 'local_kb' ? 'local_kb' : 'claude', intent, claudeCodeConfig };
  }

  return { provider: claudeCodeConfig.enabled === true ? 'claude_code_operation' : selectedProvider, intent, claudeCodeConfig };
}

function routeFromClaudeClassification({ classification, selectedProvider, claudeCodeConfig }) {
  if (!classification || classification.confidence < 0.55) {
    return null;
  }

  const intent = {
    route: classification.route,
    confidence: classification.confidence,
    reason: classification.reason,
    requiresConfirmation: classification.requiresConfirmation
  };

  if (classification.route === 'ordinary_chat') {
    return { provider: selectedProvider === 'local_kb' ? 'local_kb' : 'claude', intent, claudeCodeConfig };
  }
  if (classification.route === 'dangerous') {
    return { provider: 'claude_code_blocked', intent, claudeCodeConfig };
  }
  if (['operation', 'ambiguous'].includes(classification.route)) {
    return claudeCodeConfig.enabled === true
      ? { provider: 'claude_code_operation', intent, claudeCodeConfig }
      : { provider: 'claude_code_unavailable', intent, claudeCodeConfig };
  }

  return null;
}

async function resolveChatRoute({ message, conversation, historyMessages, results, attachments, selectedProvider, explicitProvider, baizeRoot, claudeRouteClassifier }, timings) {
  const pendingJiraOperation = await measureTiming(timings, 'pendingJiraLookupMs', () => getLatestAwaitingJiraOperation({
    conversationId: message.conversationId,
    clientId: message.clientId
  }, { baizeRoot }));
  const claudeCodeConfig = await measureTiming(timings, 'claudeCodeConfigMs', () => getClaudeCodeConfig({ baizeRoot }));

  if (selectedProvider === 'claude_code') {
    return {
      provider: claudeCodeConfig.enabled === true ? 'claude_code_operation' : 'claude_code_unavailable',
      intent: { route: 'operation', confidence: 1, reason: '用户显式选择 Claude Code', requiresConfirmation: true },
      claudeCodeConfig,
      pendingJiraOperation
    };
  }

  if (explicitProvider) {
    return { provider: selectedProvider, intent: null, claudeCodeConfig: null, pendingJiraOperation };
  }

  if (typeof claudeRouteClassifier === 'function') {
    try {
      const classification = await claudeRouteClassifier({
        message,
        knowledgeResults: results,
        attachments,
        conversationMessages: historyMessages,
        conversationSummary: conversation.manager && conversation.manager.summary,
        baizeRoot,
        onTiming: (name, value) => {
          timings[name] = value;
        }
      });
      const classifiedRoute = routeFromClaudeClassification({ classification, selectedProvider, claudeCodeConfig });
      if (classifiedRoute) {
        return { ...classifiedRoute, pendingJiraOperation };
      }
    } catch (error) {
      timings.claudeRouteClassifierFailed = true;
    }
  }

  return {
    provider: claudeCodeConfig.enabled === true ? 'claude_code_operation' : 'claude_code_unavailable',
    intent: { route: 'operation', confidence: 0.55, reason: 'Claude API 分类不可用，交给 Claude Code 判断。', requiresConfirmation: true },
    claudeCodeConfig,
    pendingJiraOperation
  };
}

async function persistTurn({ conversation, message, reply, provider, results, historyMessages, baizeRoot, jiraSearchSupplement }) {
  const userResult = await appendConversationMessage(conversation.id, {
    role: 'user',
    text: message.text,
    platform: message.platform,
    userId: message.userId,
    clientId: message.clientId
  }, { baizeRoot });
  const assistantMessage = {
    role: 'assistant',
    text: reply,
    platform: message.platform,
    userId: message.userId,
    clientId: message.clientId,
    provider,
    results
  };
  if (jiraSearchSupplement) {
    assistantMessage.jiraSearchSupplement = jiraSearchSupplement;
  }
  const assistantResult = await appendConversationMessage(conversation.id, assistantMessage, { baizeRoot });
  const updatedConversation = await observeConversationTurn({
    conversation: assistantResult.conversation,
    userMessage: userResult.message,
    assistantMessage: assistantResult.message,
    historyMessages,
    baizeRoot
  });

  return updatedConversation || assistantResult.conversation;
}

async function prepareChat(input, { baizeRoot, provider } = {}, timings) {
  const message = normalizeMessage(input);
  const conversation = await measureTiming(timings, 'ensureConversationMs', () => ensureConversation({
    conversationId: message.conversationId,
    platform: message.platform,
    userId: message.userId,
    clientId: message.clientId,
    title: message.text
  }, { baizeRoot }));
  message.conversationId = conversation.id;

  const historyMessages = await measureTiming(timings, 'loadHistoryMs', () => getConversationMessages(conversation.id, { baizeRoot }));
  const rawResults = await measureTiming(timings, 'knowledgeSearchMs', () => searchKnowledgeBase({ q: message.text, limit: 3, baizeRoot }));
  const results = sanitizeResults(rawResults);
  const selectedProvider = await measureTiming(timings, 'resolveProviderMs', () => resolveProvider({ provider, baizeRoot }));

  return {
    message,
    conversation,
    historyMessages,
    results,
    selectedProvider
  };
}

function toConversationResponse(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turnCount
  };
}

async function collectClaudeContext(message, baizeRoot, timings) {
  const [shallowMemoryResults, logicContext, skillsContext] = await measureTiming(timings, 'contextCollectionMs', () => Promise.all([
    collectShallowMemoryContext({ query: message.text, baizeRoot }),
    getLogicContext({ baizeRoot }),
    getSkillsContext({ baizeRoot })
  ]));

  return { shallowMemoryResults, logicContext, skillsContext };
}

function isOrdinaryChatIntent(message) {
  const intent = classifyEngineeringIntent({ text: message.text });
  return intent.route === 'ordinary_chat'
    && !shouldCreateJiraIssue(message.text)
    && !shouldUseJiraPlugin(message.text)
    && !shouldAddJiraComment(message.text)
    && !shouldSummarizeJiraComment(message.text)
    && !shouldBulkAddJiraComment(message.text)
    && !shouldDeleteOwnJiraComments(message.text)
    && !shouldUpdateJiraIssue(message.text)
    && !shouldTransitionJiraIssue(message.text)
    && !shouldDeleteJiraIssue(message.text);
}

async function runClaudeCodeOperationIntent({ message, conversation, historyMessages, results, attachments, baizeRoot, route, claudeCodeReplyGenerator, claudeCodeRunner, timings }) {
  const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);
  return measureTiming(timings, 'claudeCodeIntentMs', () => claudeCodeReplyGenerator({
    message,
    knowledgeResults: results,
    attachments,
    pendingJiraOperation: route.pendingJiraOperation,
    shallowMemoryResults,
    logicContext,
    skillsContext,
    conversationMessages: historyMessages,
    conversationSummary: conversation.manager && conversation.manager.summary,
    baizeRoot,
    permissionMode: 'operation_intent',
    claudeCodeConfig: route.claudeCodeConfig,
    runner: claudeCodeRunner,
    onTiming: (name, value) => {
      timings[name] = value;
    }
  }));
}

async function getOwnedJiraOperation(operationId, message, { baizeRoot } = {}) {
  const operation = await getJiraOperation(operationId, { baizeRoot });
  if (operation.clientId && message.clientId && operation.clientId !== message.clientId) {
    throw validationError('Jira 操作不属于当前客户端。');
  }
  if (operation.conversationId && message.conversationId && operation.conversationId !== message.conversationId) {
    throw validationError('Jira 操作不属于当前会话。');
  }
  return operation;
}

async function applyLogicAssertionIntent(operationIntent, { baizeRoot } = {}) {
  const result = await submitLogicAssertion({
    baizeRoot,
    category: operationIntent.category,
    statement: operationIntent.statement,
    source: 'manual'
  });
  return operationIntent.reply || formatLogicAssertionReply(result, operationIntent.statement);
}

async function updateJiraDraftsFromIntent(operationIntent, message, { baizeRoot, fetchImpl } = {}) {
  await getOwnedJiraOperation(operationIntent.operationId, message, { baizeRoot });
  return updateJiraOperationDrafts(operationIntent.operationId, operationIntent.patch, { baizeRoot, fetchImpl });
}

async function runClaudeCodeConfirmedOperationIntent({ message, conversation, historyMessages, results, attachments, operation, baizeRoot, route, claudeCodeReplyGenerator, claudeCodeRunner, timings }) {
  const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);
  return measureTiming(timings, 'claudeCodeConfirmIntentMs', () => claudeCodeReplyGenerator({
    message,
    operation,
    knowledgeResults: results,
    attachments,
    shallowMemoryResults,
    logicContext,
    skillsContext,
    conversationMessages: historyMessages,
    conversationSummary: conversation.manager && conversation.manager.summary,
    baizeRoot,
    permissionMode: 'confirmed_operation_intent',
    claudeCodeConfig: route.claudeCodeConfig,
    runner: claudeCodeRunner,
    onTiming: (name, value) => {
      timings[name] = value;
    }
  }));
}

async function runClaudeCodePluginOperationRecovery({ message, conversation, historyMessages, results, attachments, operation, baizeRoot, route, claudeCodeReplyGenerator, claudeCodeRunner, timings, emit }) {
  const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);
  return measureTiming(timings, 'claudeCodeRecoveryAnalysisMs', () => claudeCodeReplyGenerator({
    message,
    operation,
    failure: operation.failure,
    knowledgeResults: results,
    attachments,
    shallowMemoryResults,
    logicContext,
    skillsContext,
    conversationMessages: historyMessages,
    conversationSummary: conversation.manager && conversation.manager.summary,
    baizeRoot,
    permissionMode: 'plugin_operation_error_analysis',
    claudeCodeConfig: route.claudeCodeConfig,
    runner: claudeCodeRunner,
    onEvent: emit,
    onTiming: (name, value) => {
      timings[name] = value;
    }
  }));
}

async function analyzeJiraOperationRecovery({ operation, message, conversation, historyMessages, results, attachments = [], baizeRoot, route = {}, claudeCodeReplyGenerator, claudeCodeRunner, timings, emit }) {
  let recovery = buildDefaultRecoveryFromFailure(operation, operation.failure);
  const safeDefaultRecovery = operation.failure && operation.failure.classification && operation.failure.classification.safeDefaultRecovery;
  if (safeDefaultRecovery === 'retry_without_labels') {
    return attachJiraOperationRecovery(operation.id, recovery, { baizeRoot });
  }
  if (route.claudeCodeConfig && route.claudeCodeConfig.enabled === true) {
    try {
      if (typeof emit === 'function') {
        emit({ type: 'status', message: '正在让 Claude Code 分析 Jira 操作问题。' });
      }
      recovery = await runClaudeCodePluginOperationRecovery({
        message,
        conversation,
        historyMessages,
        results,
        attachments,
        operation,
        baizeRoot,
        route,
        claudeCodeReplyGenerator,
        claudeCodeRunner,
        timings,
        emit
      });
    } catch (recoveryError) {
      recovery = buildDefaultRecoveryFromFailure(operation, operation.failure);
    }
  }
  if (!['available', 'needs_user_input'].includes(recovery.status)) {
    return null;
  }
  return attachJiraOperationRecovery(operation.id, recovery, { baizeRoot });
}

async function confirmJiraOperationWithRecovery({ operation, message, conversation, historyMessages, results, attachments = [], baizeRoot, fetchImpl, route = {}, claudeCodeReplyGenerator, claudeCodeRunner, timings, emit }) {
  if (operation.status === 'awaiting_confirmation' && operation.draftImport && Array.isArray(operation.draftImport.drafts) && operation.draftImport.drafts.some((draft) => !draft.projectKey)) {
    const failedOperation = await markJiraOperationProjectRequired(operation.id, {
      conversationId: message.conversationId,
      clientId: message.clientId
    }, { baizeRoot });
    const recoveryOperation = await analyzeJiraOperationRecovery({
      operation: failedOperation,
      message,
      conversation,
      historyMessages,
      results,
      attachments,
      baizeRoot,
      route,
      claudeCodeReplyGenerator,
      claudeCodeRunner,
      timings,
      emit
    });
    if (recoveryOperation) {
      return recoveryOperation;
    }
  }
  try {
    return await confirmJiraOperation(operation.id, {
      conversationId: message.conversationId,
      clientId: message.clientId
    }, { baizeRoot, fetchImpl });
  } catch (error) {
    const failedOperation = await getJiraOperation(operation.id, { baizeRoot });
    if (!failedOperation.failure) {
      throw error;
    }

    const recoveryOperation = await analyzeJiraOperationRecovery({
      operation: failedOperation,
      message,
      conversation,
      historyMessages,
      results,
      attachments,
      baizeRoot,
      route,
      claudeCodeReplyGenerator,
      claudeCodeRunner,
      timings,
      emit
    });
    if (!recoveryOperation) {
      throw error;
    }
    return recoveryOperation;
  }
}

async function confirmJiraOperationThroughClaudeCode(operationId, input = {}, {
  baizeRoot,
  fetchImpl,
  claudeCodeReplyGenerator = runClaudeCodeTask,
  claudeCodeRunner
} = {}) {
  const timings = {};
  const operation = await getJiraOperation(operationId, { baizeRoot });
  const message = {
    platform: readString(input.platform) || 'desktop',
    userId: readString(input.userId),
    conversationId: readString(input.conversationId) || operation.conversationId,
    clientId: readString(input.clientId) || operation.clientId,
    text: readString(input.text) || '确认创建 Jira 单',
    attachmentIds: []
  };
  const conversation = await ensureConversation({
    conversationId: message.conversationId,
    platform: message.platform,
    userId: message.userId,
    clientId: message.clientId,
    title: message.text
  }, { baizeRoot });
  message.conversationId = conversation.id;
  const [historyMessages, rawResults, claudeCodeConfig] = await Promise.all([
    getConversationMessages(conversation.id, { baizeRoot }),
    searchKnowledgeBase({ q: message.text, limit: 3, baizeRoot }),
    getClaudeCodeConfig({ baizeRoot })
  ]);
  const results = sanitizeResults(rawResults);
  const route = { claudeCodeConfig };
  if (claudeCodeConfig.enabled === true) {
    await runClaudeCodeConfirmedOperationIntent({
      message,
      conversation,
      historyMessages,
      results,
      attachments: [],
      operation,
      baizeRoot,
      route,
      claudeCodeReplyGenerator,
      claudeCodeRunner,
      timings
    });
  }
  return confirmJiraOperationWithRecovery({
    operation,
    message,
    conversation,
    historyMessages,
    results,
    attachments: [],
    baizeRoot,
    fetchImpl,
    route,
    claudeCodeReplyGenerator,
    claudeCodeRunner,
    timings
  });
}

async function handleChatMessage(input = {}, {
  baizeRoot,
  provider,
  claudeReplyGenerator = generateClaudeReply,
  claudeRouteClassifier = generateChatRouteClassification,
  jiraDraftTextGenerator = generateJiraDraftTextFromXlsx,
  claudeCodeReplyGenerator = runClaudeCodeTask,
  claudeCodeRunner,
  fetchImpl
} = {}) {
  const timings = {};
  const totalStartedAt = Date.now();
  let conversation;
  let selectedProvider;

  try {
    const prepared = await prepareChat(input, { baizeRoot, provider }, timings);
    const { message, historyMessages, results } = prepared;
    conversation = prepared.conversation;
    selectedProvider = prepared.selectedProvider;
    const attachments = await measureTiming(timings, 'attachmentContextMs', () => collectMessageAttachmentContext(message, { baizeRoot }));
    const route = await resolveChatRoute({
      message,
      conversation,
      historyMessages,
      results,
      attachments,
      selectedProvider,
      explicitProvider: provider,
      baizeRoot,
      claudeRouteClassifier
    }, timings);
    selectedProvider = route.provider;
    const emitActivity = () => {};
    let reply;
    let pendingOperation = null;
    let jiraOperation = null;
    let jiraSearchSupplement = null;
    let bugAnalysisRun = null;

    if (selectedProvider === 'claude') {
      const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);

      reply = await measureTiming(timings, 'claudeReplyMs', () => claudeReplyGenerator({
        message,
        knowledgeResults: results,
        attachments,
        shallowMemoryResults,
        logicContext,
        skillsContext,
        conversationMessages: historyMessages,
        conversationSummary: conversation.manager && conversation.manager.summary,
        baizeRoot,
        onTiming: (name, value) => {
          timings[name] = value;
        }
      }));
    } else if (selectedProvider === 'claude_code_operation') {
      const operationIntent = await runClaudeCodeOperationIntent({
        message,
        conversation,
        historyMessages,
        results,
        attachments,
        baizeRoot,
        route,
        claudeCodeReplyGenerator,
        claudeCodeRunner,
        timings
      });
      if (operationIntent.kind === 'jira_bulk_create') {
        jiraOperation = await measureTiming(timings, 'jiraDraftOperationMs', () => createJiraDraftOperationFromDrafts(message, {
          fileName: 'claude-code-jira-intent.json',
          drafts: operationIntent.drafts,
          warnings: []
        }, { baizeRoot, fetchImpl }));
        reply = operationIntent.reply || formatJiraCreateReply(jiraOperation);
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_search') {
        const jiraResult = await measureTiming(timings, 'jiraSearchMs', () => searchAndAnalyzeJira(operationIntent.query, { baizeRoot, fetchImpl, claudeCodeRunner }));
        jiraSearchSupplement = jiraResult.requiresUserInput ? jiraResult.supplement : null;
        const analysisReply = formatJiraAnalysisReply(jiraResult);
        reply = operationIntent.reply ? [operationIntent.reply, analysisReply].join('\n') : analysisReply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'logic_assertion') {
        reply = await measureTiming(timings, 'logicAssertionMs', () => applyLogicAssertionIntent(operationIntent, { baizeRoot }));
        selectedProvider = 'local_kb';
      } else if (operationIntent.kind === 'jira_update_drafts') {
        jiraOperation = await measureTiming(timings, 'jiraDraftUpdateMs', () => updateJiraDraftsFromIntent(operationIntent, message, { baizeRoot, fetchImpl }));
        reply = operationIntent.reply || formatJiraDraftUpdateReply(jiraOperation);
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_reject_operation') {
        await getOwnedJiraOperation(operationIntent.operationId, message, { baizeRoot });
        jiraOperation = await measureTiming(timings, 'jiraRejectMs', () => rejectJiraOperation(operationIntent.operationId, {
          conversationId: message.conversationId,
          clientId: message.clientId
        }, { baizeRoot }));
        reply = operationIntent.reply || formatJiraRejectedReply();
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_confirm_operation') {
        const operation = await getOwnedJiraOperation(operationIntent.operationId, message, { baizeRoot });
        jiraOperation = await measureTiming(timings, 'jiraConfirmMs', () => confirmJiraOperationWithRecovery({
          operation,
          message,
          conversation,
          historyMessages,
          results,
          attachments,
          baizeRoot,
          fetchImpl,
          route,
          claudeCodeReplyGenerator,
          claudeCodeRunner,
          timings
        }));
        reply = jiraOperation.status === 'recovery_required' ? formatJiraRecoveryRequiredReply(jiraOperation) : (operationIntent.reply || formatJiraCreatedReply(jiraOperation));
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_summarize_then_comment') {
        const result = await measureTiming(timings, 'jiraSummarizedCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_summarize_then_comment',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          executor: executeJiraSummarizedCommentSimple
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_bug_analysis') {
        const result = await measureTiming(timings, 'jiraBugAnalysisCommentMs', () => runEngineeringBugAnalysisForIssues({
          operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          emitActivity
        }));
        reply = result.reply;
        bugAnalysisRun = result.bugAnalysisRun;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_bulk_add_comment') {
        const result = await measureTiming(timings, 'jiraBulkAddCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_bulk_add_comment',
          issueKeys: operationIntent.entries.map((entry) => entry.issueKey),
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          executor: executeJiraBulkAddCommentSimple
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_add_comment') {
        const result = await measureTiming(timings, 'jiraAddCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_add_comment',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          executor: executeJiraAddCommentSimple
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_delete_comment') {
        const result = await measureTiming(timings, 'jiraDeleteCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_delete_comment',
          issueKeys: (operationIntent.targets || []).map((target) => target.issueKey),
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          executor: executeJiraDeleteComment
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_update_issue') {
        const result = await measureTiming(timings, 'jiraUpdateIssueMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_update_issue',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          executor: executeJiraUpdateIssue
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_transition_issue') {
        const result = await measureTiming(timings, 'jiraTransitionIssueMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_transition_issue',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          executor: executeJiraTransitionIssue
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else if (operationIntent.kind === 'jira_delete_issue') {
        const result = await measureTiming(timings, 'jiraDeleteIssueMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_delete_issue',
          issueKeys: operationIntent.issueKeys || [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          executor: executeJiraDeleteIssue
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
      } else {
        reply = operationIntent.reply;
        selectedProvider = 'claude_code';
      }
    } else if (selectedProvider === 'claude_code') {
      emitActivity('claude_code_reply', '正在让 Claude Code 进行只读分析。');
      const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);
      reply = await measureTiming(timings, 'claudeCodeReplyMs', () => claudeCodeReplyGenerator({
        message,
        knowledgeResults: results,
        attachments,
        shallowMemoryResults,
        logicContext,
        skillsContext,
        conversationMessages: historyMessages,
        conversationSummary: conversation.manager && conversation.manager.summary,
        baizeRoot,
        permissionMode: route.claudeCodeConfig.permissions.defaultMode,
        claudeCodeConfig: route.claudeCodeConfig,
        runner: claudeCodeRunner,
        onTiming: (name, value) => {
          timings[name] = value;
        }
      }));
    } else if (selectedProvider === 'claude_code_pending') {
      pendingOperation = await measureTiming(timings, 'pendingOperationMs', () => createPendingOperation({
        conversationId: message.conversationId,
        clientId: message.clientId,
        userId: message.userId,
        platform: message.platform,
        text: message.text,
        intent: route.intent,
        permissionMode: 'write_proposal'
      }, { baizeRoot }));
      reply = formatPendingOperationReply(pendingOperation);
      selectedProvider = 'claude_code';
    } else if (selectedProvider === 'claude_code_blocked') {
      reply = formatEngineeringBlockedReply(route.intent);
      selectedProvider = 'claude_code';
    } else if (selectedProvider === 'claude_code_unavailable') {
      reply = '白泽：这个请求需要 Claude Code 判断和处理，但服务器当前没有启用 Claude Code。请先在服务器配置中启用 Claude Code 后再试。';
      selectedProvider = 'claude_code';
    } else if (selectedProvider === 'claude_code_ambiguous') {
      reply = formatAmbiguousEngineeringReply();
      selectedProvider = 'claude_code';
    } else if (selectedProvider === 'jira_create') {
      jiraOperation = await measureTiming(timings, 'jiraDraftOperationMs', () => createJiraDraftOperationFromText(message, { baizeRoot, fetchImpl, jiraDraftTextGenerator, onTiming: (name, value) => { timings[name] = value; } }));
      reply = formatJiraCreateReply(jiraOperation);
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira_update') {
      jiraOperation = await measureTiming(timings, 'jiraDraftUpdateMs', () => updateJiraOperationDrafts(route.jiraOperation.id, route.draftPatch, { baizeRoot, fetchImpl }));
      reply = formatJiraDraftUpdateReply(jiraOperation);
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira_confirm') {
      if (route.claudeCodeConfig && route.claudeCodeConfig.enabled === true) {
        await runClaudeCodeConfirmedOperationIntent({
          message,
          conversation,
          historyMessages,
          results,
          attachments,
          operation: route.jiraOperation,
          baizeRoot,
          route,
          claudeCodeReplyGenerator,
          claudeCodeRunner,
          timings
        });
      }
      jiraOperation = await measureTiming(timings, 'jiraConfirmMs', () => confirmJiraOperationWithRecovery({
        operation: route.jiraOperation,
        message,
        conversation,
        historyMessages,
        results,
        attachments,
        baizeRoot,
        fetchImpl,
        route,
        claudeCodeReplyGenerator,
        claudeCodeRunner,
        timings
      }));
      reply = jiraOperation.status === 'recovery_required' ? formatJiraRecoveryRequiredReply(jiraOperation) : formatJiraCreatedReply(jiraOperation);
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira_add_comment') {
      const request = extractJiraCommentRequest(message.text);
      const intent = request ? { issueKey: request.issueKey, body: request.body } : { issueKey: null, body: null };
      const result = await measureTiming(timings, 'jiraAddCommentMs', () => runPluginWriteThroughGateway({
        plugin: 'jira',
        kind: 'jira_add_comment',
        issueKeys: intent.issueKey ? [intent.issueKey] : [],
        triggerSource: 'client',
        intent,
        message,
        baizeRoot,
        fetchImpl,
        claudeCodeRunner,
        executor: executeJiraAddCommentSimple
      }));
      reply = result.reply;
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira_delete_own_comments') {
      const deleteResult = await measureTiming(timings, 'jiraDeleteOwnCommentsMs', () => executeJiraDeleteOwnComments(route.intent, { baizeRoot, fetchImpl, claudeCodeRunner }));
      reply = deleteResult.reply;
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira_summarize_then_comment_unavailable') {
      reply = '白泽：自动总结后写 Jira 评论需要先启用 Claude Code。';
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira_reject') {
      jiraOperation = await measureTiming(timings, 'jiraRejectMs', () => rejectJiraOperation(route.jiraOperation.id, {
        conversationId: message.conversationId,
        clientId: message.clientId
      }, { baizeRoot }));
      reply = formatJiraRejectedReply();
      selectedProvider = 'jira';
    } else if (selectedProvider === 'jira') {
      emitActivity('jira_search', '正在执行 Jira 搜索。');
      const jiraResult = await measureTiming(timings, 'jiraSearchMs', () => searchAndAnalyzeJira(extractJiraQuery(message.text), { baizeRoot, fetchImpl, claudeCodeRunner }));
      jiraSearchSupplement = jiraResult.requiresUserInput ? jiraResult.supplement : null;
      reply = formatJiraAnalysisReply(jiraResult);
    } else {
      reply = formatReply(message.text, results);
    }

    const updatedConversation = await measureTiming(timings, 'persistTurnMs', () => persistTurn({
      conversation,
      message,
      reply,
      provider: selectedProvider,
      results,
      historyMessages,
      baizeRoot,
      jiraSearchSupplement
    }));

    timings.totalMs = Date.now() - totalStartedAt;
    await logChatTiming({
      baizeRoot,
      conversationId: conversation.id,
      provider: selectedProvider,
      status: 'ok',
      timings
    });

    return {
      reply,
      message,
      results,
      provider: selectedProvider,
      conversation: toConversationResponse(updatedConversation),
      pendingOperation,
      jiraOperation,
      jiraSearchSupplement,
      bugAnalysisRun
    };
  } catch (error) {
    timings.totalMs = Date.now() - totalStartedAt;
    await logChatTiming({
      baizeRoot,
      conversationId: conversation && conversation.id,
      provider: selectedProvider,
      status: 'error',
      timings
    });
    throw error;
  }
}

async function handleChatMessageStream(input = {}, {
  baizeRoot,
  provider,
  claudeReplyGenerator = generateClaudeReplyStream,
  claudeRouteClassifier = generateChatRouteClassification,
  jiraDraftTextGenerator = generateJiraDraftTextFromXlsx,
  claudeCodeReplyGenerator = runClaudeCodeTask,
  claudeCodeRunner,
  fetchImpl,
  onEvent
} = {}) {
  const timings = {};
  const totalStartedAt = Date.now();
  let conversation;
  let selectedProvider;

  try {
    const prepared = await prepareChat(input, { baizeRoot, provider }, timings);
    const { message, historyMessages, results } = prepared;
    conversation = prepared.conversation;
    selectedProvider = prepared.selectedProvider;
    const attachments = await measureTiming(timings, 'attachmentContextMs', () => collectMessageAttachmentContext(message, { baizeRoot }));
    const route = await resolveChatRoute({
      message,
      conversation,
      historyMessages,
      results,
      attachments,
      selectedProvider,
      explicitProvider: provider,
      baizeRoot,
      claudeRouteClassifier
    }, timings);
    selectedProvider = route.provider;
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const emitActivity = (step, activityMessage) => emit({ type: 'activity', step, message: activityMessage, at: new Date().toISOString() });

    const metaProvider = ['claude_code_pending', 'claude_code_blocked', 'claude_code_ambiguous', 'claude_code_operation'].includes(selectedProvider) ? 'claude_code' : ['jira_create', 'jira_update', 'jira_confirm', 'jira_reject'].includes(selectedProvider) ? 'jira' : selectedProvider;
    emit({ type: 'meta', message, results, provider: metaProvider, conversation: toConversationResponse(conversation) });
    emitActivity('route_resolved', `已选择处理通道：${metaProvider}`);

    let reply;
    let pendingOperation = null;
    let jiraOperation = null;
    let jiraSearchSupplement = null;
    let bugAnalysisRun = null;
    if (selectedProvider === 'claude') {
      emitActivity('claude_reply', '正在让 Claude 整合知识库与上下文生成回复。');
      const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);
      reply = await measureTiming(timings, 'claudeReplyMs', () => claudeReplyGenerator({
        message,
        knowledgeResults: results,
        attachments,
        shallowMemoryResults,
        logicContext,
        skillsContext,
        conversationMessages: historyMessages,
        conversationSummary: conversation.manager && conversation.manager.summary,
        baizeRoot,
        onDelta: (text) => emit({ type: 'delta', text }),
        onTiming: (name, value) => {
          timings[name] = value;
        }
      }));
    } else if (selectedProvider === 'claude_code_operation') {
      emitActivity('claude_code_operation_intent', '正在让 Claude Code 解析操作意图。');
      const operationIntent = await runClaudeCodeOperationIntent({
        message,
        conversation,
        historyMessages,
        results,
        attachments,
        baizeRoot,
        route,
        claudeCodeReplyGenerator,
        claudeCodeRunner,
        timings
      });
      if (operationIntent.kind === 'jira_bulk_create') {
        emitActivity('jira_draft_operation', '正在生成 Jira 单草稿。');
        jiraOperation = await measureTiming(timings, 'jiraDraftOperationMs', () => createJiraDraftOperationFromDrafts(message, {
          fileName: 'claude-code-jira-intent.json',
          drafts: operationIntent.drafts,
          warnings: []
        }, { baizeRoot, fetchImpl }));
        reply = operationIntent.reply || formatJiraCreateReply(jiraOperation);
        selectedProvider = 'jira';
        emit({ type: 'jira_operation_required', message: reply, operation: jiraOperation });
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_search') {
        emitActivity('jira_search', '正在执行 Jira 搜索。');
        const jiraResult = await measureTiming(timings, 'jiraSearchMs', () => searchAndAnalyzeJira(operationIntent.query, { baizeRoot, fetchImpl, claudeCodeRunner }));
        jiraSearchSupplement = jiraResult.requiresUserInput ? jiraResult.supplement : null;
        const analysisReply = formatJiraAnalysisReply(jiraResult);
        reply = operationIntent.reply ? [operationIntent.reply, analysisReply].join('\n') : analysisReply;
        selectedProvider = 'jira';
        if (jiraResult.requiresUserInput && jiraResult.supplement) {
          emit({ type: 'jira_search_supplement_required', message: analysisReply, supplement: jiraResult.supplement });
        }
        if (jiraResult.notRecoverable) {
          emit({ type: 'jira_search_recovery_not_recoverable', message: analysisReply, recovery: jiraResult.jiraSearchRecovery });
        }
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'logic_assertion') {
        emitActivity('logic_assertion', '正在保存 Claude Code 判断出的逻辑断言。');
        reply = await measureTiming(timings, 'logicAssertionMs', () => applyLogicAssertionIntent(operationIntent, { baizeRoot }));
        selectedProvider = 'local_kb';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_update_drafts') {
        emitActivity('jira_draft_update', '正在按 Claude Code 结构化意图更新 Jira 草稿。');
        jiraOperation = await measureTiming(timings, 'jiraDraftUpdateMs', () => updateJiraDraftsFromIntent(operationIntent, message, { baizeRoot, fetchImpl }));
        reply = operationIntent.reply || formatJiraDraftUpdateReply(jiraOperation);
        selectedProvider = 'jira';
        emit({ type: 'jira_operation_required', message: reply, operation: jiraOperation });
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_reject_operation') {
        emitActivity('jira_reject', '正在取消当前 Jira 创建草稿。');
        await getOwnedJiraOperation(operationIntent.operationId, message, { baizeRoot });
        jiraOperation = await measureTiming(timings, 'jiraRejectMs', () => rejectJiraOperation(operationIntent.operationId, {
          conversationId: message.conversationId,
          clientId: message.clientId
        }, { baizeRoot }));
        reply = operationIntent.reply || formatJiraRejectedReply();
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_confirm_operation') {
        emitActivity('jira_confirm', '正在执行 Claude Code 确认的 Jira 创建操作。');
        const operation = await getOwnedJiraOperation(operationIntent.operationId, message, { baizeRoot });
        jiraOperation = await measureTiming(timings, 'jiraConfirmMs', () => confirmJiraOperationWithRecovery({
          operation,
          message,
          conversation,
          historyMessages,
          results,
          attachments,
          baizeRoot,
          fetchImpl,
          route,
          claudeCodeReplyGenerator,
          claudeCodeRunner,
          timings,
          emit
        }));
        reply = jiraOperation.status === 'recovery_required' ? formatJiraRecoveryRequiredReply(jiraOperation) : (operationIntent.reply || formatJiraCreatedReply(jiraOperation));
        selectedProvider = 'jira';
        if (jiraOperation.status === 'recovery_required') {
          emit({ type: 'jira_operation_recovery_required', message: reply, operation: jiraOperation });
        }
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_summarize_then_comment') {
        emitActivity('jira_summarize_then_comment', '准备让审计官评估 Claude Code 起草的 Jira 评论。');
        emit({
          type: 'jira_comment_preview',
          issueKey: operationIntent.issueKey,
          body: operationIntent.body,
          sources: Array.isArray(operationIntent.sources) ? operationIntent.sources : []
        });
        const result = await measureTiming(timings, 'jiraSummarizedCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_summarize_then_comment',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          emit,
          emitActivity,
          claudeCodeRunner,
          executor: executeJiraSummarizedCommentSimple
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_bug_analysis') {
        emitActivity('jira_bug_analysis_workspace', `准备进入工程级 BUG 分析流程处理 ${operationIntent.issueKeys.length} 个 Jira Bug 单。`);
        const result = await measureTiming(timings, 'jiraBugAnalysisCommentMs', () => runEngineeringBugAnalysisForIssues({
          operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          claudeCodeRunner,
          emitActivity
        }));
        reply = result.reply;
        bugAnalysisRun = result.bugAnalysisRun;
        emit({
          type: 'jira_bug_analysis_started',
          run: result.bugAnalysisRun,
          reused: result.reused,
          enqueued: result.enqueued,
          alreadyRunning: result.alreadyRunning,
          issueKeys: operationIntent.issueKeys
        });
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_bulk_add_comment') {
        emitActivity('jira_bulk_add_comment', `准备让审计官评估 ${operationIntent.entries.length} 个 Jira 单的评论写入。`);
        emit({
          type: 'jira_comment_preview',
          entries: operationIntent.entries.map((entry) => ({
            issueKey: entry.issueKey,
            body: entry.body,
            sources: Array.isArray(entry.sources) ? entry.sources : []
          }))
        });
        const result = await measureTiming(timings, 'jiraBulkAddCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_bulk_add_comment',
          issueKeys: operationIntent.entries.map((entry) => entry.issueKey),
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          emit,
          emitActivity,
          claudeCodeRunner,
          executor: executeJiraBulkAddCommentSimple
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_delete_comment') {
        emitActivity('jira_delete_comment', `正在让审计官评估 ${operationIntent.targets.length} 个 Jira 单的删评论请求。`);
        const result = await measureTiming(timings, 'jiraDeleteCommentMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_delete_comment',
          issueKeys: (operationIntent.targets || []).map((target) => target.issueKey),
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          emit,
          emitActivity,
          claudeCodeRunner,
          executor: executeJiraDeleteComment
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_update_issue') {
        emitActivity('jira_update_issue', `准备让审计官评估 ${operationIntent.issueKey} 的字段更新。`);
        const result = await measureTiming(timings, 'jiraUpdateIssueMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_update_issue',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          emit,
          emitActivity,
          executor: executeJiraUpdateIssue
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_transition_issue') {
        emitActivity('jira_transition_issue', `准备让审计官评估 ${operationIntent.issueKey} 的状态变更。`);
        const result = await measureTiming(timings, 'jiraTransitionIssueMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_transition_issue',
          issueKeys: operationIntent.issueKey ? [operationIntent.issueKey] : [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          emit,
          emitActivity,
          executor: executeJiraTransitionIssue
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else if (operationIntent.kind === 'jira_delete_issue') {
        emitActivity('jira_delete_issue', `准备让审计官评估 ${(operationIntent.issueKeys || []).length} 个 Jira 单的删除请求。`);
        const result = await measureTiming(timings, 'jiraDeleteIssueMs', () => runPluginWriteThroughGateway({
          plugin: 'jira',
          kind: 'jira_delete_issue',
          issueKeys: operationIntent.issueKeys || [],
          triggerSource: 'client',
          intent: operationIntent,
          message,
          baizeRoot,
          fetchImpl,
          emit,
          emitActivity,
          executor: executeJiraDeleteIssue
        }));
        reply = operationIntent.reply ? [operationIntent.reply, result.reply].join('\n') : result.reply;
        selectedProvider = 'jira';
        emit({ type: 'delta', text: reply });
      } else {
        reply = operationIntent.reply;
        selectedProvider = 'claude_code';
        emit({ type: 'delta', text: reply });
      }
    } else if (selectedProvider === 'claude_code') {
      emitActivity('claude_code_reply', '正在让 Claude Code 进行只读分析。');
      const { shallowMemoryResults, logicContext, skillsContext } = await collectClaudeContext(message, baizeRoot, timings);
      reply = await measureTiming(timings, 'claudeCodeReplyMs', () => claudeCodeReplyGenerator({
        message,
        knowledgeResults: results,
        attachments,
        shallowMemoryResults,
        logicContext,
        skillsContext,
        conversationMessages: historyMessages,
        conversationSummary: conversation.manager && conversation.manager.summary,
        baizeRoot,
        permissionMode: route.claudeCodeConfig.permissions.defaultMode,
        claudeCodeConfig: route.claudeCodeConfig,
        runner: claudeCodeRunner,
        onDelta: (text) => emit({ type: 'delta', text }),
        onEvent: emit,
        onTiming: (name, value) => {
          timings[name] = value;
        }
      }));
    } else if (selectedProvider === 'claude_code_pending') {
      pendingOperation = await measureTiming(timings, 'pendingOperationMs', () => createPendingOperation({
        conversationId: message.conversationId,
        clientId: message.clientId,
        userId: message.userId,
        platform: message.platform,
        text: message.text,
        intent: route.intent,
        permissionMode: 'write_proposal'
      }, { baizeRoot }));
      reply = formatPendingOperationReply(pendingOperation);
      selectedProvider = 'claude_code';
      emit({ type: 'permission_required', message: reply, permission: toPermissionRequired(pendingOperation) });
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'claude_code_blocked') {
      reply = formatEngineeringBlockedReply(route.intent);
      selectedProvider = 'claude_code';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'claude_code_unavailable') {
      reply = '白泽：这个请求需要 Claude Code 判断和处理，但服务器当前没有启用 Claude Code。请先在服务器配置中启用 Claude Code 后再试。';
      selectedProvider = 'claude_code';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'claude_code_ambiguous') {
      reply = formatAmbiguousEngineeringReply();
      selectedProvider = 'claude_code';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_create') {
      emitActivity('jira_draft_operation', '正在生成 Jira 单草稿。');
      jiraOperation = await measureTiming(timings, 'jiraDraftOperationMs', () => createJiraDraftOperationFromText(message, { baizeRoot, fetchImpl, jiraDraftTextGenerator, onTiming: (name, value) => { timings[name] = value; } }));
      reply = formatJiraCreateReply(jiraOperation);
      selectedProvider = 'jira';
      emit({ type: 'jira_operation_required', message: reply, operation: jiraOperation });
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_update') {
      emitActivity('jira_draft_update', '正在更新 Jira 草稿。');
      jiraOperation = await measureTiming(timings, 'jiraDraftUpdateMs', () => updateJiraOperationDrafts(route.jiraOperation.id, route.draftPatch, { baizeRoot, fetchImpl }));
      reply = formatJiraDraftUpdateReply(jiraOperation);
      selectedProvider = 'jira';
      emit({ type: 'jira_operation_required', message: reply, operation: jiraOperation });
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_confirm') {
      if (route.claudeCodeConfig && route.claudeCodeConfig.enabled === true) {
        emit({ type: 'status', message: '正在让 Claude Code 校验已确认的 Jira 操作。' });
        await runClaudeCodeConfirmedOperationIntent({
          message,
          conversation,
          historyMessages,
          results,
          attachments,
          operation: route.jiraOperation,
          baizeRoot,
          route,
          claudeCodeReplyGenerator,
          claudeCodeRunner,
          timings
        });
      }
      emit({ type: 'status', message: '正在创建 Jira 单。' });
      jiraOperation = await measureTiming(timings, 'jiraConfirmMs', () => confirmJiraOperationWithRecovery({
        operation: route.jiraOperation,
        message,
        conversation,
        historyMessages,
        results,
        attachments,
        baizeRoot,
        fetchImpl,
        route,
        claudeCodeReplyGenerator,
        claudeCodeRunner,
        timings,
        emit
      }));
      reply = jiraOperation.status === 'recovery_required' ? formatJiraRecoveryRequiredReply(jiraOperation) : formatJiraCreatedReply(jiraOperation);
      selectedProvider = 'jira';
      if (jiraOperation.status === 'recovery_required') {
        emit({ type: 'jira_operation_recovery_required', message: reply, operation: jiraOperation });
      }
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_add_comment') {
      emitActivity('jira_add_comment', '准备让审计官评估 Jira 评论写入。');
      const request = extractJiraCommentRequest(message.text);
      const intent = request ? { issueKey: request.issueKey, body: request.body } : { issueKey: null, body: null };
      const result = await measureTiming(timings, 'jiraAddCommentMs', () => runPluginWriteThroughGateway({
        plugin: 'jira',
        kind: 'jira_add_comment',
        issueKeys: intent.issueKey ? [intent.issueKey] : [],
        triggerSource: 'client',
        intent,
        message,
        baizeRoot,
        fetchImpl,
        emit,
        emitActivity,
        claudeCodeRunner,
        executor: executeJiraAddCommentSimple
      }));
      reply = result.reply;
      selectedProvider = 'jira';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_delete_own_comments') {
      emitActivity('jira_delete_own_comments', '正在清理白泽自己写的 Jira 评论。');
      const deleteResult = await measureTiming(timings, 'jiraDeleteOwnCommentsMs', () => executeJiraDeleteOwnComments(route.intent, {
        baizeRoot,
        fetchImpl,
        claudeCodeRunner,
        onIssueResult: (result) => emit({ type: 'jira_comment_delete_result', ...result })
      }));
      reply = deleteResult.reply;
      selectedProvider = 'jira';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_summarize_then_comment_unavailable') {
      reply = '白泽：自动总结后写 Jira 评论需要先启用 Claude Code。';
      selectedProvider = 'jira';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira_reject') {
      jiraOperation = await measureTiming(timings, 'jiraRejectMs', () => rejectJiraOperation(route.jiraOperation.id, {
        conversationId: message.conversationId,
        clientId: message.clientId
      }, { baizeRoot }));
      reply = formatJiraRejectedReply();
      selectedProvider = 'jira';
      emit({ type: 'delta', text: reply });
    } else if (selectedProvider === 'jira') {
      emitActivity('jira_search', '正在执行 Jira 搜索。');
      const jiraResult = await measureTiming(timings, 'jiraSearchMs', () => searchAndAnalyzeJira(extractJiraQuery(message.text), { baizeRoot, fetchImpl, claudeCodeRunner }));
      jiraSearchSupplement = jiraResult.requiresUserInput ? jiraResult.supplement : null;
      reply = formatJiraAnalysisReply(jiraResult);
      if (jiraResult.requiresUserInput && jiraResult.supplement) {
        emit({ type: 'jira_search_supplement_required', message: reply, supplement: jiraResult.supplement });
      }
      if (jiraResult.notRecoverable) {
        emit({ type: 'jira_search_recovery_not_recoverable', message: reply, recovery: jiraResult.jiraSearchRecovery });
      }
      emit({ type: 'delta', text: reply });
    } else {
      reply = formatReply(message.text, results);
      emit({ type: 'delta', text: reply });
    }

    const updatedConversation = await measureTiming(timings, 'persistTurnMs', () => persistTurn({
      conversation,
      message,
      reply,
      provider: selectedProvider,
      results,
      historyMessages,
      baizeRoot,
      jiraSearchSupplement
    }));

    timings.totalMs = Date.now() - totalStartedAt;
    await logChatTiming({
      baizeRoot,
      conversationId: conversation.id,
      provider: selectedProvider,
      status: 'ok',
      timings
    });

    const result = {
      reply,
      message,
      results,
      provider: selectedProvider,
      conversation: toConversationResponse(updatedConversation),
      pendingOperation,
      jiraOperation,
      jiraSearchSupplement,
      bugAnalysisRun
    };
    emit({ type: 'done', ...result });
    return result;
  } catch (error) {
    timings.totalMs = Date.now() - totalStartedAt;
    await logChatTiming({
      baizeRoot,
      conversationId: conversation && conversation.id,
      provider: selectedProvider,
      status: 'error',
      timings
    });
    throw error;
  }
}

const PLUGIN_EXECUTORS = {
  jira_add_comment: executeJiraAddCommentSimple,
  jira_bulk_add_comment: executeJiraBulkAddCommentSimple,
  jira_summarize_then_comment: executeJiraSummarizedCommentSimple,
  jira_delete_comment: executeJiraDeleteComment,
  jira_update_issue: executeJiraUpdateIssue,
  jira_transition_issue: executeJiraTransitionIssue,
  jira_delete_issue: executeJiraDeleteIssue
};

async function confirmPluginAudit(auditId, input = {}, { fetchImpl, claudeCodeRunner } = {}) {
  const record = await getPendingAudit(auditId, { baizeRoot: input.baizeRoot });
  if (!record) {
    return { error: '审计记录已过期或不存在。', auditId };
  }
  if (record.status !== 'awaiting_confirmation') {
    return { error: `审计记录当前状态为 ${record.status}，无法再次确认。`, auditId };
  }
  const executor = PLUGIN_EXECUTORS[record.kind];
  if (!executor) {
    return { error: `没有为意图 ${record.kind} 注册执行器。`, auditId };
  }
  await markPendingAuditStatus(auditId, 'executing', { baizeRoot: input.baizeRoot });
  const confirmedAudit = record.audit && typeof record.audit === 'object'
    ? {
        ...record.audit,
        decision: 'allow',
        perIssue: Array.isArray(record.audit.perIssue)
          ? record.audit.perIssue.map((item) => item && item.decision === 'deny'
              ? item
              : { ...item, decision: 'allow' })
          : record.audit.perIssue
      }
    : record.audit;
  try {
    const result = await executePluginIntentWithRecovery({
      plugin: record.plugin || 'jira',
      kind: record.kind,
      audit: confirmedAudit,
      intent: record.intent,
      baizeRoot: input.baizeRoot,
      fetchImpl,
      executor,
      claudeCodeRunner
    });
    await markPendingAuditStatus(auditId, 'executed', { baizeRoot: input.baizeRoot });
    return { auditId, status: 'executed', result };
  } catch (error) {
    await markPendingAuditStatus(auditId, 'failed', { baizeRoot: input.baizeRoot });
    return { auditId, status: 'failed', error: error.publicMessage || error.message || '未知错误' };
  }
}

async function rejectPluginAudit(auditId, input = {}) {
  const record = await getPendingAudit(auditId, { baizeRoot: input.baizeRoot });
  if (!record) {
    return { error: '审计记录已过期或不存在。', auditId };
  }
  await markPendingAuditStatus(auditId, 'rejected', { baizeRoot: input.baizeRoot });
  return { auditId, status: 'rejected' };
}

module.exports = {
  handleChatMessage,
  handleChatMessageStream,
  confirmJiraOperationThroughClaudeCode,
  confirmPluginAudit,
  rejectPluginAudit
};
