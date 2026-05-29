const { getClaudeCodeConfig, getJiraConfig } = require('./config-service');
const { searchJira, jiraError, requestJira, sanitizeJiraApiError, classifyJiraSearchApiError } = require('./jira-client-service');
const { runClaudeCodeTask } = require('./claude-code-service');

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function quoteJqlValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeList);
  }
  const single = readString(value);
  if (!single) {
    return [];
  }
  return single.split(/[，,、；;]|\s+和\s+|和/).map(readString).filter(Boolean);
}

function unique(items) {
  return Array.from(new Set(items.map(readString).filter(Boolean)));
}

function quoteJqlIdentifier(value) {
  const text = readString(value);
  if (!text) {
    return null;
  }
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(text) ? text : quoteJqlValue(text);
}

function buildInClause(fieldName, values) {
  const field = quoteJqlIdentifier(fieldName);
  const normalized = unique(values);
  if (!field || normalized.length === 0) {
    return null;
  }
  return normalized.length === 1
    ? `${field} = ${quoteJqlValue(normalized[0])}`
    : `${field} in (${normalized.map(quoteJqlValue).join(', ')})`;
}

const ALLOWED_ORDER_FIELDS = new Set(['updated', 'created', 'resolutiondate', 'statuscategorychangedate']);

function normalizeOrderBy(value) {
  const text = readString(value);
  if (!text) {
    return 'updated DESC';
  }
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_]*)\s*(ASC|DESC)?$/i);
    if (!match) {
      continue;
    }
    const field = match[1].toLowerCase();
    if (!ALLOWED_ORDER_FIELDS.has(field)) {
      continue;
    }
    normalized.push(`${field} ${(match[2] || 'DESC').toUpperCase()}`);
  }
  return normalized.length > 0 ? normalized.join(', ') : 'updated DESC';
}

async function resolveJiraUsers(config, query, options = {}) {
  const term = readString(query);
  if (!term) {
    return [];
  }
  try {
    const users = await requestJira(config, `/user/search?username=${encodeURIComponent(term)}`, { fetchImpl: options.fetchImpl });
    return Array.isArray(users) ? users.filter((user) => user && user.active !== false).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function getTaskOwnerFieldNames(config = {}, input = {}) {
  return unique([
    ...(Array.isArray(input.ownerFieldNames) ? input.ownerFieldNames : []),
    config.fieldMappings && config.fieldMappings.taskOwnerName,
    '任务负责人'
  ]);
}

function getUserIdentifiers(user = {}) {
  return unique([user.name, user.key, user.displayName, user.emailAddress]);
}

function getJqlUserNames(users = [], fallbackPeople = []) {
  const resolvedNames = unique(users.map((user) => user && user.name));
  return resolvedNames.length > 0 ? resolvedNames : unique(fallbackPeople);
}

function buildAssigneeOrOwnerClause({ config, input, users }) {
  const requestedPeople = normalizeList(input.assignee || input.assignees || input.owner || input.owners || input.person || input.people);
  if (requestedPeople.length === 0) {
    return null;
  }
  const userNames = getJqlUserNames(users, requestedPeople);
  const clauses = [buildInClause('assignee', userNames)];
  for (const fieldName of getTaskOwnerFieldNames(config, input)) {
    clauses.push(buildInClause(fieldName, userNames));
  }
  const effectiveClauses = clauses.filter(Boolean);
  return effectiveClauses.length > 1 ? `(${effectiveClauses.join(' OR ')})` : effectiveClauses[0] || null;
}

function normalizeSearchInput(input = {}) {
  const labels = normalizeList(input.label || input.labels);
  const bugLabel = labels.find((label) => /^bug$/i.test(label));
  if (!bugLabel) {
    return { ...input, labels };
  }
  return {
    ...input,
    projectKey: readString(input.projectKey) || 'BUG',
    labels: labels.filter((label) => !/^bug$/i.test(label))
  };
}

function buildJql(input = {}, defaults = {}) {
  input = normalizeSearchInput(input);
  const explicitJql = readString(input.jql);
  if (explicitJql) {
    return explicitJql;
  }

  const clauses = [];
  const projectKey = readString(input.projectKey) || readString(defaults.projectKey);
  if (projectKey) {
    clauses.push(`project = ${quoteJqlValue(projectKey)}`);
  }

  for (const assignee of normalizeList(input.assignee || input.assignees)) {
    clauses.push(`assignee = ${quoteJqlValue(assignee)}`);
  }
  const statuses = normalizeList(input.status || input.statuses);
  const statusClause = buildInClause('status', statuses);
  if (statusClause) {
    clauses.push(statusClause);
  }
  const issueTypeClause = buildInClause('issuetype', normalizeList(input.issueType || input.issueTypes));
  if (issueTypeClause) {
    clauses.push(issueTypeClause);
  }
  for (const label of normalizeList(input.label || input.labels)) {
    clauses.push(`labels = ${quoteJqlValue(label)}`);
  }

  const updatedAfter = readString(input.updatedAfter);
  const updatedBefore = readString(input.updatedBefore);
  if (updatedAfter) {
    clauses.push(`updated >= ${quoteJqlValue(updatedAfter)}`);
  }
  if (updatedBefore) {
    clauses.push(`updated <= ${quoteJqlValue(updatedBefore)}`);
  }
  const resolvedAfter = readString(input.resolvedAfter);
  const resolvedBefore = readString(input.resolvedBefore);
  if (resolvedAfter) {
    clauses.push(`resolutiondate >= ${quoteJqlValue(resolvedAfter)}`);
  }
  if (resolvedBefore) {
    clauses.push(`resolutiondate <= ${quoteJqlValue(resolvedBefore)}`);
  }
  const statusCategory = readString(input.statusCategory);
  if (statusCategory) {
    clauses.push(`statusCategory = ${quoteJqlValue(statusCategory)}`);
  }

  if (clauses.length === 0) {
    throw jiraError('请至少提供一个 Jira 查询条件。');
  }
  const orderBy = normalizeOrderBy(input.orderBy);
  return `${clauses.join(' AND ')} ORDER BY ${orderBy}`;
}

const DONE_STATUS_CATEGORIES = new Set(['done', 'complete', 'completed', '完成']);
const DONE_STATUS_NAMES = new Set(['done', 'closed', 'resolved', '完成', '已关闭', '已解决']);

function isDoneStatus(fields = {}) {
  const status = fields.status || {};
  const categoryName = readString(status.statusCategory && status.statusCategory.name);
  const categoryKey = readString(status.statusCategory && status.statusCategory.key);
  const statusName = readString(status.name);
  return Boolean(
    (categoryName && DONE_STATUS_CATEGORIES.has(categoryName.toLowerCase())) ||
    (categoryKey && DONE_STATUS_CATEGORIES.has(categoryKey.toLowerCase())) ||
    (statusName && DONE_STATUS_NAMES.has(statusName.toLowerCase()))
  );
}

function readTimestamp(value) {
  const text = readString(value);
  if (!text) {
    return null;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : { text, time };
}

function buildIssueTiming(fields = {}) {
  const created = readTimestamp(fields.created);
  if (!created) {
    return null;
  }
  const candidates = [
    { source: 'resolutiondate', value: readTimestamp(fields.resolutiondate) },
    { source: 'statuscategorychangedate', value: isDoneStatus(fields) ? readTimestamp(fields.statuscategorychangedate) : null },
    { source: 'updated_fallback', value: readTimestamp(fields.updated) }
  ];
  const completed = candidates.find((candidate) => candidate.value && candidate.value.time >= created.time);
  if (!completed) {
    return {
      createdAt: created.text,
      completedAt: null,
      completionSource: null,
      completionDurationMs: null
    };
  }
  return {
    createdAt: created.text,
    completedAt: completed.value.text,
    completionSource: completed.source,
    completionDurationMs: completed.value.time - created.time
  };
}

function simplifyIssue(issue = {}, { includeCompletionTiming = false } = {}) {
  const fields = issue.fields || {};
  const simplified = {
    key: issue.key,
    id: issue.id,
    summary: fields.summary || '',
    status: fields.status && fields.status.name ? fields.status.name : '',
    assignee: fields.assignee && fields.assignee.displayName ? fields.assignee.displayName : null,
    issueType: fields.issuetype && fields.issuetype.name ? fields.issuetype.name : null,
    project: fields.project && fields.project.key ? fields.project.key : null,
    priority: fields.priority && fields.priority.name ? fields.priority.name : null,
    created: fields.created || null,
    updated: fields.updated || null
  };
  if (includeCompletionTiming) {
    simplified.resolutiondate = fields.resolutiondate || null;
    simplified.statuscategorychangedate = fields.statuscategorychangedate || null;
    simplified.statusCategory = fields.status && fields.status.statusCategory && fields.status.statusCategory.name ? fields.status.statusCategory.name : null;
    simplified.timing = buildIssueTiming(fields);
  }
  return simplified;
}

function buildUserAmbiguityPrompt({ input, term, users }) {
  return [
    '你是白泽的 Jira 搜索歧义分析器。服务器正在执行只读 Jira 查询，不会写入 Jira。',
    'Jira 用户搜索返回多个候选时，你需要根据用户原始查询、候选 displayName/name/email 判断是否能自动选择。',
    '如果能确定用户想要的是哪些候选，输出 resolved；如果不能确定且必须由用户选择，输出 needs_user_input。',
    '只输出严格 JSON，不要输出 Markdown 代码块，不要解释。',
    '允许格式：',
    '{"kind":"jira_search_candidate_resolution","status":"resolved","selectedUserNames":["jira username"],"reason":"中文原因"}',
    '{"kind":"jira_search_candidate_resolution","status":"needs_user_input","reason":"中文原因","choices":[{"value":"jira username","label":"显示给用户的文本"}]}',
    '',
    `用户查询：${JSON.stringify(input)}`,
    `待解析姓名/关键词：${term}`,
    `候选用户：${JSON.stringify(users.map((user) => ({ name: user.name, key: user.key, displayName: user.displayName, emailAddress: user.emailAddress, active: user.active })), null, 2)}`
  ].join('\n');
}

function parseCandidateResolution(output, users = []) {
  let parsed;
  try {
    parsed = JSON.parse(String(output || '').trim());
  } catch {
    return null;
  }
  if (!parsed || parsed.kind !== 'jira_search_candidate_resolution') {
    return null;
  }
  const status = readString(parsed.status);
  if (status === 'resolved') {
    const selected = unique(parsed.selectedUserNames || []);
    const matched = users.filter((user) => selected.some((value) => getUserIdentifiers(user).includes(value)));
    return matched.length > 0 ? { status: 'resolved', users: matched, reason: readString(parsed.reason) } : null;
  }
  if (status === 'needs_user_input') {
    const choices = Array.isArray(parsed.choices) ? parsed.choices.map((choice) => {
      const value = readString(choice && choice.value);
      if (!value) {
        return null;
      }
      return { value, label: readString(choice.label) || value };
    }).filter(Boolean) : users.map((user) => ({ value: user.name || user.key, label: user.displayName || user.name || user.key })).filter((choice) => choice.value);
    return {
      status: 'needs_user_input',
      reason: readString(parsed.reason) || '需要选择 Jira 用户。',
      choices
    };
  }
  return null;
}

async function resolveAmbiguousUsersWithClaudeCode({ config, input, term, users }, options = {}) {
  if (users.length <= 1) {
    return { status: 'resolved', users };
  }
  const claudeCodeConfig = await getClaudeCodeConfig(options);
  if (claudeCodeConfig.enabled !== true && !options.claudeCodeRunner) {
    return { status: 'resolved', users };
  }
  try {
    const output = await runClaudeCodeTask({
      message: { text: buildUserAmbiguityPrompt({ input, term, users }) },
      permissionMode: 'read_only',
      claudeCodeConfig,
      runner: options.claudeCodeRunner
    });
    return parseCandidateResolution(output, users) || { status: 'resolved', users };
  } catch {
    return { status: 'resolved', users };
  }
}

function buildEmptySearchAnalysis(summary) {
  return { total: 0, byStatus: {}, byAssignee: {}, completionRate: 0, blockedKeys: [], summary };
}

function analyzeCompletionTiming(issues = []) {
  const sourceCounts = {};
  let totalDurationMs = 0;
  let issuesWithCompletion = 0;
  for (const issue of issues) {
    const timing = issue && issue.timing;
    if (!timing || !Number.isFinite(timing.completionDurationMs)) {
      continue;
    }
    issuesWithCompletion += 1;
    totalDurationMs += timing.completionDurationMs;
    const source = timing.completionSource || 'unknown';
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }
  const averageCompletionMs = issuesWithCompletion > 0 ? Math.round(totalDurationMs / issuesWithCompletion) : null;
  return {
    totalIssues: issues.length,
    issuesWithCompletion,
    missingCompletion: issues.length - issuesWithCompletion,
    averageCompletionMs,
    averageCompletionHours: averageCompletionMs === null ? null : Number((averageCompletionMs / 3600000).toFixed(2)),
    averageCompletionDays: averageCompletionMs === null ? null : Number((averageCompletionMs / 86400000).toFixed(2)),
    completionSources: sourceCounts
  };
}

function analyzeIssues(issues = []) {
  const byStatus = {};
  const byAssignee = {};
  for (const issue of issues) {
    const status = issue.status || '未设置状态';
    const assignee = issue.assignee || '未分配';
    byStatus[status] = (byStatus[status] || 0) + 1;
    byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;
  }

  const blockedStatuses = ['Blocked', '阻塞', '暂停', '无法进行'];
  const doneStatuses = ['Done', 'Closed', 'Resolved', '完成', '已关闭', '已解决'];
  const blocked = issues.filter((issue) => blockedStatuses.includes(issue.status));
  const doneCount = issues.filter((issue) => doneStatuses.includes(issue.status)).length;
  const completionRate = issues.length === 0 ? 0 : Math.round((doneCount / issues.length) * 100);

  return {
    total: issues.length,
    byStatus,
    byAssignee,
    completionRate,
    blockedKeys: blocked.map((issue) => issue.key),
    summary: issues.length === 0
      ? '没有找到符合条件的 Jira 需求单。'
      : `共找到 ${issues.length} 个需求单，完成率约 ${completionRate}%。${blocked.length > 0 ? `其中 ${blocked.length} 个处于阻塞状态。` : '当前没有识别到阻塞状态需求。'}`
  };
}

async function buildResolvedJql(input = {}, config = {}, options = {}) {
  input = normalizeSearchInput(input);
  const explicitJql = readString(input.jql);
  if (explicitJql) {
    return { jql: explicitJql, resolvedUsers: [] };
  }

  const personTerms = normalizeList(input.assignee || input.assignees || input.owner || input.owners || input.person || input.people);
  const resolvedUsers = [];
  const userResolution = [];
  for (const term of personTerms) {
    const candidates = await resolveJiraUsers(config, term, options);
    const resolution = await resolveAmbiguousUsersWithClaudeCode({ config, input, term, users: candidates }, options);
    userResolution.push({ term, status: resolution.status, candidates, selectedUsers: resolution.users || [], reason: resolution.reason, choices: resolution.choices });
    if (resolution.status === 'needs_user_input') {
      return {
        requiresUserInput: true,
        jql: null,
        resolvedUsers: [],
        supplement: {
          prompt: resolution.reason || `请确认“${term}”对应哪个 Jira 用户。`,
          inputs: [{
            id: `jiraUser:${term}`,
            type: 'select',
            label: `选择 Jira 用户：${term}`,
            required: true,
            options: (resolution.choices || []).map((choice) => choice.value)
          }],
          choices: resolution.choices || []
        },
        userResolution
      };
    }
    resolvedUsers.push(...(resolution.users || candidates));
  }

  const clauses = [];
  const projectKey = readString(input.projectKey) || readString(config.defaultProjectKey);
  if (projectKey) {
    clauses.push(`project = ${quoteJqlValue(projectKey)}`);
  }

  const assigneeOrOwnerClause = buildAssigneeOrOwnerClause({ config, input, users: resolvedUsers });
  if (assigneeOrOwnerClause) {
    clauses.push(assigneeOrOwnerClause);
  }
  const statuses = normalizeList(input.status || input.statuses);
  const statusClause = buildInClause('status', statuses);
  if (statusClause) {
    clauses.push(statusClause);
  }
  const issueTypeClause = buildInClause('issuetype', normalizeList(input.issueType || input.issueTypes));
  if (issueTypeClause) {
    clauses.push(issueTypeClause);
  }
  for (const label of normalizeList(input.label || input.labels)) {
    clauses.push(`labels = ${quoteJqlValue(label)}`);
  }

  const updatedAfter = readString(input.updatedAfter);
  const updatedBefore = readString(input.updatedBefore);
  if (updatedAfter) {
    clauses.push(`updated >= ${quoteJqlValue(updatedAfter)}`);
  }
  if (updatedBefore) {
    clauses.push(`updated <= ${quoteJqlValue(updatedBefore)}`);
  }
  const resolvedAfter = readString(input.resolvedAfter);
  const resolvedBefore = readString(input.resolvedBefore);
  if (resolvedAfter) {
    clauses.push(`resolutiondate >= ${quoteJqlValue(resolvedAfter)}`);
  }
  if (resolvedBefore) {
    clauses.push(`resolutiondate <= ${quoteJqlValue(resolvedBefore)}`);
  }
  const statusCategory = readString(input.statusCategory);
  if (statusCategory) {
    clauses.push(`statusCategory = ${quoteJqlValue(statusCategory)}`);
  }

  if (clauses.length === 0) {
    throw jiraError('请至少提供一个 Jira 查询条件。');
  }
  const orderBy = normalizeOrderBy(input.orderBy);
  return {
    jql: `${clauses.join(' AND ')} ORDER BY ${orderBy}`,
    resolvedUsers: unique(resolvedUsers.map((user) => user.displayName || user.name)),
    userResolution
  };
}

const MAX_JIRA_SEARCH_RECOVERY_ATTEMPTS = 3;
const RECOVERABLE_JIRA_SEARCH_ERROR_CODES = ['JIRA_API_ERROR', 'JIRA_REQUEST_TIMEOUT'];

function sanitizeSearchInputForRecovery(input = {}) {
  const safe = {};
  for (const key of ['projectKey', 'assignee', 'assignees', 'owner', 'owners', 'person', 'people', 'status', 'statuses', 'issueType', 'issueTypes', 'labels', 'updatedAfter', 'updatedBefore']) {
    if (input[key] !== undefined) {
      safe[key] = input[key];
    }
  }
  if (Number.isInteger(input.maxResults) && input.maxResults > 0) {
    safe.maxResults = Math.min(input.maxResults, 100);
  }
  return safe;
}

function validateJiraSearchRecoveryJql(jql, originalJql) {
  const text = readString(jql);
  if (!text) {
    return { valid: false, reason: 'Claude Code 没有给出可用 JQL。' };
  }
  if (text.length > 2000) {
    return { valid: false, reason: 'Claude Code 给的 JQL 过长。' };
  }
  if (/[ -;]/.test(text)) {
    return { valid: false, reason: 'Claude Code 给的 JQL 含有非法字符。' };
  }
  if (/\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|ALTER|CREATE)\b/i.test(text)) {
    return { valid: false, reason: 'Claude Code 给的 JQL 含有破坏性关键词。' };
  }
  const upper = text.toUpperCase();
  const constraintPatterns = [/PROJECT\s*[=!~]/i, /ASSIGNEE\s*[=!~]/i, /"任务负责人"/, /STATUS\s*[=!~]|STATUS\s+IN\b/i, /ISSUETYPE\s*[=!~]|ISSUETYPE\s+IN\b/i, /LABELS\s*[=!~]/i, /UPDATED\s*[<>=]/i, /KEY\s*[=!~]/i];
  if (!constraintPatterns.some((re) => re.test(text))) {
    return { valid: false, reason: 'Claude Code 给的 JQL 没有有效约束。' };
  }
  if (/^\s*ORDER\s+BY/i.test(text)) {
    return { valid: false, reason: 'Claude Code 给的 JQL 只有排序。' };
  }
  const normalized = /\bORDER\s+BY\b/i.test(text) ? text : `${text} ORDER BY updated DESC`;
  if (readString(originalJql) && normalized.trim() === readString(originalJql).trim()) {
    return { valid: false, reason: 'Claude Code 没有改写原 JQL。' };
  }
  return { valid: true, jql: normalized };
}

async function analyzeJiraSearchErrorWithClaudeCode({ input, resolved, jql, error, attempt, maxAttempts }, options = {}) {
  const claudeCodeConfig = await getClaudeCodeConfig(options);
  if (claudeCodeConfig.enabled !== true && !options.claudeCodeRunner) {
    return {
      status: 'not_recoverable',
      analyzedBy: 'server',
      analyzedAt: new Date().toISOString(),
      summary: 'Claude Code 未启用，无法自动分析 Jira 搜索失败。',
      reason: '请在 Claude Code 启用后再试。',
      action: { id: 'not_recoverable', label: '无法自动恢复', style: 'secondary', requiresConfirmation: false }
    };
  }
  const sanitizedError = sanitizeJiraApiError(error);
  const classification = classifyJiraSearchApiError(error);
  try {
    return await runClaudeCodeTask({
      message: { text: '请分析 Jira 搜索失败并给出安全恢复建议。' },
      permissionMode: 'jira_search_error_analysis',
      claudeCodeConfig,
      runner: options.claudeCodeRunner,
      searchFailure: {
        query: sanitizeSearchInputForRecovery(input),
        jql,
        error: sanitizedError,
        classification,
        attempt,
        maxAttempts,
        maxResults: Number.isInteger(input.maxResults) && input.maxResults > 0 ? Math.min(input.maxResults, 100) : 50
      }
    });
  } catch (analysisError) {
    return {
      status: 'not_recoverable',
      analyzedBy: 'claude_code',
      analyzedAt: new Date().toISOString(),
      summary: 'Claude Code 没有给出可用的 Jira 搜索恢复方案。',
      reason: analysisError && analysisError.publicMessage ? analysisError.publicMessage : '解析 Claude Code 输出失败。',
      action: { id: 'not_recoverable', label: '无法自动恢复', style: 'secondary', requiresConfirmation: false }
    };
  }
}

async function searchAndAnalyzeJira(input = {}, options = {}) {
  const config = await getJiraConfig(options);
  const resolved = await buildResolvedJql(input, config, options);
  if (resolved.requiresUserInput) {
    return {
      requiresUserInput: true,
      jql: null,
      resolvedUsers: [],
      userResolution: resolved.userResolution || [],
      supplement: resolved.supplement,
      total: 0,
      issues: [],
      analysis: buildEmptySearchAnalysis('需要确认 Jira 查询条件后才能继续。')
    };
  }

  const maxResults = Number.isInteger(input.maxResults) && input.maxResults > 0 ? Math.min(input.maxResults, 100) : 50;
  const originalJql = resolved.jql;
  let currentJql = resolved.jql;
  const recoveryAttempts = [];

  for (let attempt = 1; attempt <= MAX_JIRA_SEARCH_RECOVERY_ATTEMPTS + 1; attempt++) {
    try {
      const includeCompletionTiming = input.includeCompletionTiming === true;
      const timingFields = includeCompletionTiming ? ['resolutiondate', 'statuscategorychangedate'] : [];
      const requestedFields = Array.isArray(input.fields) ? input.fields : [];
      const raw = await searchJira(config, {
        jql: currentJql,
        maxResults,
        fields: [...requestedFields, ...timingFields],
        fetchImpl: options.fetchImpl,
        timeoutMs: options.jiraTimeoutMs
      });
      const issues = Array.isArray(raw.issues) ? raw.issues.map((issue) => simplifyIssue(issue, { includeCompletionTiming })) : [];
      const result = {
        jql: currentJql,
        resolvedUsers: resolved.resolvedUsers,
        userResolution: resolved.userResolution || [],
        total: raw.total || issues.length,
        issues,
        analysis: analyzeIssues(issues)
      };
      if (includeCompletionTiming) {
        result.timingAnalysis = analyzeCompletionTiming(issues);
      }
      if (recoveryAttempts.length > 0) {
        result.originalJql = originalJql;
        result.jiraSearchRecovery = {
          status: 'retry_succeeded',
          attempts: recoveryAttempts.length,
          history: recoveryAttempts
        };
      }
      return result;
    } catch (error) {
      if (!error || !RECOVERABLE_JIRA_SEARCH_ERROR_CODES.includes(error.code)) {
        throw error;
      }
      if (attempt > MAX_JIRA_SEARCH_RECOVERY_ATTEMPTS) {
        return {
          notRecoverable: true,
          jql: currentJql,
          originalJql,
          resolvedUsers: resolved.resolvedUsers,
          userResolution: resolved.userResolution || [],
          total: 0,
          issues: [],
          analysis: buildEmptySearchAnalysis('多次尝试后仍无法完成 Jira 搜索。'),
          jiraSearchRecovery: {
            status: 'not_recoverable',
            attempts: recoveryAttempts.length,
            history: recoveryAttempts,
            summary: '已达到 Jira 搜索自动恢复次数上限。',
            reason: '请补充 Jira 查询条件或人工排查。'
          }
        };
      }
      if (input.disableRecovery === true || input.clientOperation === true) {
        return {
          notRecoverable: true,
          jql: currentJql,
          originalJql,
          resolvedUsers: resolved.resolvedUsers,
          userResolution: resolved.userResolution || [],
          total: 0,
          issues: [],
          analysis: buildEmptySearchAnalysis('Jira 搜索失败，客户端操作不启用自动恢复。'),
          jiraSearchRecovery: {
            status: 'disabled',
            attempts: recoveryAttempts.length,
            history: recoveryAttempts,
            summary: '客户端 Jira 操作已禁用服务器 Claude Code 自动恢复。',
            reason: error.publicMessage || error.message || 'Jira 搜索失败。'
          }
        };
      }
      const recovery = await analyzeJiraSearchErrorWithClaudeCode({
        input,
        resolved,
        jql: currentJql,
        error,
        attempt,
        maxAttempts: MAX_JIRA_SEARCH_RECOVERY_ATTEMPTS
      }, options);
      recoveryAttempts.push({ attempt, jql: currentJql, status: recovery.status, summary: recovery.summary, reason: recovery.reason });

      if (recovery.status === 'needs_user_input') {
        return {
          requiresUserInput: true,
          jql: null,
          originalJql,
          resolvedUsers: [],
          userResolution: resolved.userResolution || [],
          supplement: recovery.supplement || {
            prompt: recovery.reason || '请补充 Jira 查询条件。',
            inputs: []
          },
          total: 0,
          issues: [],
          analysis: buildEmptySearchAnalysis('需要补充 Jira 查询条件后才能继续。'),
          jiraSearchRecovery: { status: 'needs_user_input', attempts: recoveryAttempts.length, history: recoveryAttempts, summary: recovery.summary, reason: recovery.reason }
        };
      }

      if (recovery.status === 'retry_available') {
        const validated = validateJiraSearchRecoveryJql(recovery.retry && recovery.retry.jql, currentJql);
        if (!validated.valid) {
          return {
            notRecoverable: true,
            jql: currentJql,
            originalJql,
            resolvedUsers: resolved.resolvedUsers,
            userResolution: resolved.userResolution || [],
            total: 0,
            issues: [],
            analysis: buildEmptySearchAnalysis('Claude Code 给出的 Jira 重试 JQL 不安全。'),
            jiraSearchRecovery: { status: 'not_recoverable', attempts: recoveryAttempts.length, history: recoveryAttempts, summary: 'Claude Code 重试 JQL 未通过服务器校验。', reason: validated.reason }
          };
        }
        currentJql = validated.jql;
        continue;
      }

      return {
        notRecoverable: true,
        jql: currentJql,
        originalJql,
        resolvedUsers: resolved.resolvedUsers,
        userResolution: resolved.userResolution || [],
        total: 0,
        issues: [],
        analysis: buildEmptySearchAnalysis('无法自动恢复这次 Jira 搜索失败。'),
        jiraSearchRecovery: { status: 'not_recoverable', attempts: recoveryAttempts.length, history: recoveryAttempts, summary: recovery.summary || '无法自动恢复。', reason: recovery.reason }
      };
    }
  }

  return {
    notRecoverable: true,
    jql: currentJql,
    originalJql,
    resolvedUsers: resolved.resolvedUsers,
    userResolution: resolved.userResolution || [],
    total: 0,
    issues: [],
    analysis: buildEmptySearchAnalysis('Jira 搜索恢复循环异常退出。'),
    jiraSearchRecovery: { status: 'not_recoverable', attempts: recoveryAttempts.length, history: recoveryAttempts }
  };
}

module.exports = {
  buildJql,
  buildResolvedJql,
  resolveJiraUsers,
  simplifyIssue,
  analyzeIssues,
  searchAndAnalyzeJira
};
