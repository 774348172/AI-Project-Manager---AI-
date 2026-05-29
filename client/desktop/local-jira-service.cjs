const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

function nowIso(now = new Date()) {
  return now.toISOString();
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function jiraError(message, code = 'VALIDATION_ERROR', statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  Object.assign(error, details);
  return error;
}

function getStorePaths(userDataPath) {
  const root = path.join(userDataPath, 'runtime', 'jira-operations');
  return {
    root,
    indexFile: path.join(root, 'index.json')
  };
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim() === '' ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (readString(value)) {
      return readString(value);
    }
  }
  return null;
}

function parseLabels(value) {
  const text = readString(value);
  if (!text) {
    return [];
  }
  return text.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeDraft(row = {}, config = {}) {
  const summary = pick(row, ['summary', '标题', '需求标题', '名称', 'title']);
  if (!summary) {
    return null;
  }
  return {
    summary,
    description: pick(row, ['description', '描述', '需求描述', '内容', 'body']) || '',
    projectKey: pick(row, ['projectKey', 'project', '项目', '项目Key']) || config.defaultProjectKey,
    issueType: pick(row, ['issueType', 'type', '类型', '需求类型']) || config.defaultIssueType || 'Task',
    assignee: pick(row, ['assignee', '经办人', '负责人', '处理人']),
    priority: pick(row, ['priority', '优先级']),
    labels: Array.isArray(row.labels) ? row.labels.map(readString).filter(Boolean) : parseLabels(pick(row, ['labels', '标签']))
  };
}

function parseFieldLine(line) {
  const match = line.match(/^[\s\-*•]*([A-Za-z]+|[一-龥]+(?:[A-Za-z]+)?)\s*[:：]\s*(.+)$/);
  if (!match) {
    return null;
  }
  const keyMap = {
    summary: 'summary',
    title: 'summary',
    标题: 'summary',
    需求标题: 'summary',
    名称: 'summary',
    description: 'description',
    描述: 'description',
    需求描述: 'description',
    内容: 'description',
    project: 'projectKey',
    projectKey: 'projectKey',
    项目: 'projectKey',
    项目Key: 'projectKey',
    issueType: 'issueType',
    type: 'issueType',
    类型: 'issueType',
    需求类型: 'issueType',
    assignee: 'assignee',
    经办人: 'assignee',
    负责人: 'assignee',
    处理人: 'assignee',
    labels: 'labels',
    标签: 'labels',
    priority: 'priority',
    优先级: 'priority'
  };
  const key = keyMap[match[1]];
  return key ? { key, value: match[2].trim() } : null;
}

function parseStructuredTextRows(lines) {
  const rows = [];
  let current = null;
  let matched = false;
  for (const line of lines) {
    const field = parseFieldLine(line);
    if (!field) {
      continue;
    }
    matched = true;
    if (!current || (field.key === 'summary' && current.summary)) {
      if (current) {
        rows.push(current);
      }
      current = {};
    }
    current[field.key] = field.value;
  }
  if (current) {
    rows.push(current);
  }
  if (!matched) {
    return [];
  }
  return rows.map((row) => ({
    ...row,
    summary: row.summary || row.description
  })).filter((row) => row.summary);
}

function readNaturalField(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && readString(match[1])) {
      return readString(match[1]);
    }
  }
  return null;
}

function parseNaturalTextRow(line) {
  if (!/jira/i.test(line) || !/(创建|新建|需求单|任务|issue|单子)/i.test(line)) {
    return null;
  }
  const projectKey = readNaturalField(line, [
    /项目\s*(?:的)?\s*(?:key|Key|KEY)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]*)/,
    /project\s*(?:key)?\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]*)/i
  ]);
  const summary = readNaturalField(line, [
    /(?:单子名字|需求单名字|任务名字|标题|名称|summary)\s*(?:就叫做|叫做|为|是|[:：])\s*([^，,。；;\n]+?)(?=\s+项目|\s+project|$)/i,
    /(?:创建|新建).*?(?:jira|Jira).*?(?:需求单|任务|issue|单子).*?(?:叫做|为|是)\s*([^，,。；;\n]+?)(?=\s+项目|\s+project|$)/i
  ]) || line.replace(/项目\s*(?:的)?\s*(?:key|Key|KEY)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]*/g, '').trim();
  const assignee = readNaturalField(line, [
    /给\s*([一-龥A-Za-z0-9_.-]+)\s*(?:创建|新建)/,
    /(?:负责人|经办人|处理人|任务负责人)\s*(?:是|为|:|：)?\s*([一-龥A-Za-z0-9_.-]+)/
  ]);
  return { summary, projectKey, assignee };
}

function parseTextRows(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const structuredRows = parseStructuredTextRows(lines);
  if (structuredRows.length > 0) {
    return structuredRows;
  }
  if (lines.some((line) => /[|\t]/.test(line))) {
    return lines.map((line) => {
      const parts = line.split(/[|\t]/).map((part) => part.trim());
      return {
        summary: parts[0],
        description: parts.slice(1).join('\n')
      };
    });
  }
  const naturalRows = lines.map(parseNaturalTextRow).filter(Boolean);
  if (naturalRows.length > 0) {
    return naturalRows;
  }
  return lines.map((line) => ({ summary: line, description: '' }));
}

function decodeContent(input = {}) {
  if (Buffer.isBuffer(input.buffer)) {
    return { fileName: readString(input.fileName) || 'jira-import.txt', buffer: input.buffer };
  }
  if (readString(input.contentBase64)) {
    return { fileName: readString(input.fileName) || 'jira-import.txt', buffer: Buffer.from(input.contentBase64, 'base64') };
  }
  if (readString(input.text)) {
    return { fileName: readString(input.fileName) || 'jira-import.txt', buffer: Buffer.from(input.text, 'utf8') };
  }
  throw jiraError('请提供 xlsx 或文本内容。');
}

function isWritableCustomField(fieldId) {
  return /^customfield_\d+$/.test(readString(fieldId) || '');
}

function draftToJiraFields(draft = {}, config = {}) {
  if (!draft.projectKey) {
    throw jiraError('Jira 项目 Key 不能为空。');
  }
  const project = draft.projectId ? { id: draft.projectId } : { key: draft.projectKey };
  const fields = {
    project,
    summary: draft.summary,
    description: draft.description || '',
    issuetype: draft.issueTypeId ? { id: draft.issueTypeId } : { name: draft.issueType || config.defaultIssueType || 'Task' }
  };
  const assigneeValue = draft.assigneeName || draft.assigneeAccountId || draft.assignee;
  if (draft.assigneeAccountId || draft.assigneeName || draft.assignee) {
    fields.assignee = config.deploymentType === 'cloud'
      ? { accountId: draft.assigneeAccountId || draft.assignee }
      : { name: draft.assigneeName || draft.assignee };
  }
  const taskOwnerField = config.fieldMappings && (config.fieldMappings.taskOwner || config.fieldMappings.assignee || config.fieldMappings.任务负责人);
  if (isWritableCustomField(taskOwnerField) && assigneeValue) {
    fields[taskOwnerField] = assigneeValue;
  }
  if (draft.priority) {
    fields.priority = { name: draft.priority };
  }
  if (Array.isArray(draft.labels) && draft.labels.length > 0) {
    fields.labels = draft.labels;
  }
  return fields;
}

function normalizeBaseUrl(baseURL) {
  const value = readString(baseURL);
  if (!value) {
    throw jiraError('Jira 服务器地址未配置。');
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('invalid protocol');
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw jiraError('Jira 服务器地址格式无效。');
  }
}

function assertJiraReady(config = {}) {
  if (!config.enabled) {
    throw jiraError('Jira 插件未启用。');
  }
  normalizeBaseUrl(config.baseURL);
  if (config.authType === 'bearer' && !config.apiToken) {
    throw jiraError('Jira 访问 Token 未配置。');
  }
  if (config.authType !== 'bearer' && !config.email && !config.username) {
    throw jiraError('Jira 账号未配置。');
  }
  if (config.authType !== 'bearer' && !config.password && !config.apiToken) {
    throw jiraError('Jira 密码或 API Token 未配置。');
  }
}

function buildAuthHeader(config) {
  if (config.authType === 'bearer') {
    return `Bearer ${config.apiToken}`;
  }
  const account = config.username || config.email;
  const credential = config.password || config.apiToken;
  return `Basic ${Buffer.from(`${account}:${credential}`).toString('base64')}`;
}

const JIRA_FIELD_NAMES = {
  labels: '标签',
  issuetype: '问题类型',
  project: '项目',
  summary: '标题',
  description: '描述',
  assignee: '负责人',
  priority: '优先级'
};

function translateJiraApiMessage(message) {
  const text = String(message || '').trim();
  if (!text) {
    return '';
  }
  if (/Field '([^']+)' cannot be set\. It is not on the appropriate screen, or unknown\./i.test(text)) {
    const field = text.match(/Field '([^']+)' cannot be set/i)[1];
    const fieldName = JIRA_FIELD_NAMES[field] || field;
    return `${fieldName}字段不能创建：该字段不在当前 Jira 创建界面中，或 Jira 不认识这个字段。`;
  }
  return text;
}

function formatJiraApiError(data = {}) {
  const messages = [];
  if (Array.isArray(data.errorMessages)) {
    messages.push(...data.errorMessages.map(translateJiraApiMessage).filter(Boolean));
  }
  if (data.errors && typeof data.errors === 'object') {
    for (const [field, message] of Object.entries(data.errors)) {
      const translatedMessage = translateJiraApiMessage(message);
      if (translatedMessage) {
        const fieldName = JIRA_FIELD_NAMES[field] || field;
        messages.push(`${fieldName}: ${translatedMessage}`);
      }
    }
  }
  return messages.length > 0 ? messages.join('；') : 'Jira 请求失败。';
}

function classifyJiraApiError(error = {}) {
  const message = `${error.publicMessage || error.message || ''} ${JSON.stringify(error.jira && error.jira.errors ? error.jira.errors : {})}`;
  if (error.code === 'JIRA_API_ERROR' && /(?:labels|标签字段不能创建|Field 'labels' cannot be set)/i.test(message)) {
    return { type: 'field_not_on_create_screen', field: 'labels', safeDefaultRecovery: 'retry_without_labels' };
  }
  return { type: 'unknown', field: null, safeDefaultRecovery: null };
}

async function requestJira(config, pathname, { method = 'GET', body, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  assertJiraReady(config);
  const baseURL = normalizeBaseUrl(config.baseURL);
  const controller = new AbortController();
  const timeoutError = jiraError(`Jira 请求超过 ${Math.round(timeoutMs / 1000)} 秒，请让 Claude Code 分析原因后缩小条件重试。`, 'JIRA_REQUEST_TIMEOUT', 504, {
    jira: { errorMessages: ['Jira request timed out.'] }
  });
  let timeoutId;
  try {
    const response = await Promise.race([
      fetchImpl(`${baseURL}/rest/api/${config.apiVersion}${pathname}`, {
        method,
        headers: {
          Authorization: buildAuthHeader(config),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      })
    ]);
    const text = await response.text();
    const data = text.trim() === '' ? {} : JSON.parse(text);
    if (!response.ok) {
      throw jiraError(formatJiraApiError(data), 'JIRA_API_ERROR', response.status, {
        jira: {
          status: response.status,
          errors: data && data.errors && typeof data.errors === 'object' ? data.errors : {},
          errorMessages: Array.isArray(data && data.errorMessages) ? data.errorMessages : []
        }
      });
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createJiraIssue(config, fields, options = {}) {
  return requestJira(config, '/issue', { ...options, method: 'POST', body: { fields } });
}

function sanitize(operation) {
  if (!operation) {
    return null;
  }
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    clientId: operation.clientId,
    userId: operation.userId,
    conversationId: operation.conversationId,
    draftImport: operation.draftImport,
    createdIssues: operation.createdIssues,
    error: operation.error,
    failure: operation.failure || null,
    recovery: operation.recovery || null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt
  };
}

function buildDraftWarnings(drafts) {
  const warnings = [];
  if (drafts.some((draft) => !draft.projectKey)) {
    warnings.push('存在未配置项目 Key 的草稿，确认创建前需要补充项目。');
  }
  if (drafts.some((draft) => draft.projectKey && draft.projectValid === false)) {
    warnings.push('存在 Jira 项目 Key 无法通过只读接口校验的草稿，请确认项目是否存在。');
  }
  return warnings;
}

function hasProjectProblem(draft = {}) {
  return !draft.projectKey || draft.projectValid === false;
}

function mergeWarnings(...warningLists) {
  return [...new Set(warningLists.flat().filter(Boolean))];
}

function sanitizeDraftForRecovery(draft = {}) {
  return {
    summary: draft.summary,
    projectKey: draft.projectKey,
    issueType: draft.issueType,
    assignee: draft.assignee,
    priority: draft.priority,
    labels: Array.isArray(draft.labels) ? draft.labels : []
  };
}

function sanitizeJiraProject(project = {}) {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    issueTypes: Array.isArray(project.issueTypes) ? project.issueTypes.map((type) => ({ id: type.id, name: type.name, subtask: type.subtask === true })) : []
  };
}

function sanitizeCreateMeta(metadata = {}) {
  return {
    projects: Array.isArray(metadata.projects) ? metadata.projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      issuetypes: Array.isArray(project.issuetypes) ? project.issuetypes.map((issueType) => ({
        id: issueType.id,
        name: issueType.name,
        fields: issueType.fields && typeof issueType.fields === 'object' ? Object.fromEntries(Object.entries(issueType.fields).map(([fieldId, field]) => [fieldId, {
          required: field.required === true,
          name: field.name,
          schema: field.schema,
          allowedValues: Array.isArray(field.allowedValues) ? field.allowedValues.slice(0, 20).map((item) => ({ id: item.id, name: item.name, value: item.value, key: item.key })) : undefined
        }])) : {}
      })) : []
    })) : []
  };
}

function sanitizeJiraUsers(users) {
  return Array.isArray(users) ? users.slice(0, 10).map((user) => ({
    name: user.name,
    key: user.key,
    accountId: user.accountId,
    displayName: user.displayName,
    emailAddress: user.emailAddress,
    active: user.active
  })) : [];
}

function summarizeCreatedIssue(created = {}, draft = {}) {
  return { id: created.id, key: created.key, self: created.self, summary: draft.summary };
}

function buildJiraProjectRequiredFailureContext(operation) {
  const drafts = operation.draftImport && Array.isArray(operation.draftImport.drafts) ? operation.draftImport.drafts : [];
  const problemDrafts = drafts.map((draft, index) => ({ index, draft })).filter((item) => hasProjectProblem(item.draft));
  const invalidProjectKeyCount = problemDrafts.filter((item) => item.draft.projectKey && item.draft.projectValid === false).length;
  const missingProjectKeyCount = problemDrafts.filter((item) => !item.draft.projectKey).length;
  const message = invalidProjectKeyCount > 0
    ? '存在 Jira 无法识别的项目 Key，确认创建前需要补充或修正项目。'
    : '存在未配置项目 Key 的草稿，确认创建前需要补充项目。';
  return {
    plugin: 'jira',
    operationKind: operation.kind,
    code: 'JIRA_PROJECT_REQUIRED',
    statusCode: 409,
    message,
    failedAt: nowIso(),
    failedDraftIndex: problemDrafts.length > 0 ? problemDrafts[0].index : -1,
    createdCount: Array.isArray(operation.createdIssues) ? operation.createdIssues.length : 0,
    retryable: false,
    requiresUserInput: true,
    classification: { type: invalidProjectKeyCount > 0 ? 'invalid_project_key' : 'missing_required_field', field: 'projectKey', safeDefaultRecovery: 'submit_supplement' },
    sanitizedRequestContext: {
      draftCount: drafts.length,
      missingProjectKeyCount,
      invalidProjectKeyCount,
      draftsMissingProjectKey: problemDrafts.map((item) => ({
        index: item.index,
        currentDraft: sanitizeDraftForRecovery(item.draft)
      }))
    }
  };
}

function buildJiraCreateFailureContext({ error, operation, draft, draftIndex, fields, createdIssues }) {
  const classification = classifyJiraApiError(error);
  return {
    plugin: 'jira',
    operationKind: operation.kind,
    code: error.code || 'UNKNOWN_ERROR',
    statusCode: error.statusCode || 500,
    message: error.publicMessage || error.message,
    failedAt: nowIso(),
    failedDraftIndex: draftIndex,
    createdCount: createdIssues.length,
    retryable: classification.safeDefaultRecovery !== null,
    classification,
    sanitizedRequestContext: {
      draftCount: operation.draftImport && Array.isArray(operation.draftImport.drafts) ? operation.draftImport.drafts.length : 0,
      createdCount: createdIssues.length,
      currentDraft: sanitizeDraftForRecovery(draft),
      fieldKeysAttempted: Object.keys(fields || {})
    },
    jira: error.jira || undefined
  };
}

function buildDefaultRecoveryFromFailure(operation, failure) {
  if (failure && failure.classification && failure.classification.safeDefaultRecovery === 'submit_supplement') {
    const invalidProjectKeyCount = failure.sanitizedRequestContext && failure.sanitizedRequestContext.invalidProjectKeyCount;
    return {
      status: 'needs_user_input',
      analyzedBy: 'client',
      analyzedAt: nowIso(),
      summary: invalidProjectKeyCount > 0 ? '创建 Jira 前需要修正项目 Key。' : '创建 Jira 前需要补充项目 Key。',
      reason: invalidProjectKeyCount > 0
        ? '当前 Jira 账号无法通过只读接口识别草稿里的项目 Key，可能是项目不存在、Key 写错，或账号没有项目权限。'
        : 'Jira 创建必须知道每个草稿要写入哪个项目；当前有草稿缺少 projectKey。',
      supplement: {
        prompt: invalidProjectKeyCount > 0 ? '请填写当前 Jira 账号可访问的项目 Key。' : '请填写这些 Jira 单要创建到哪个项目 Key。',
        inputs: [{ id: 'projectKey', type: 'text', label: '项目 Key', required: true }],
        actions: [{ id: 'submit_supplement', kind: 'submit', label: '提交项目 Key', style: 'primary', requiresConfirmation: false, riskLevel: 'low' }]
      },
      actions: [{
        id: 'submit_supplement',
        kind: 'submit',
        label: '提交项目 Key',
        style: 'primary',
        requiresConfirmation: false,
        riskLevel: 'low',
        description: '把项目 Key 写入缺少项目的 Jira 草稿。'
      }, {
        id: 'cancel',
        kind: 'cancel',
        label: '取消创建',
        style: 'secondary',
        requiresConfirmation: false,
        riskLevel: 'low',
        description: '取消本次 Jira 创建。'
      }]
    };
  }
  if (failure && failure.classification && failure.classification.safeDefaultRecovery === 'retry_without_labels') {
    return {
      status: 'available',
      analyzedBy: 'client',
      analyzedAt: nowIso(),
      summary: 'Jira 当前创建界面不允许设置标签字段，可以移除标签后重试创建。',
      reason: 'labels 是附加字段；移除后会保留标题、描述、项目、类型、负责人和优先级等核心字段。',
      actions: [{
        id: 'retry_without_labels',
        kind: 'safe_retry',
        label: '移除标签后重试创建',
        style: 'primary',
        requiresConfirmation: true,
        riskLevel: 'low',
        description: '保留其他字段，只移除 labels 后重新创建未成功的 Jira 单。'
      }, {
        id: 'cancel',
        kind: 'cancel',
        label: '取消创建',
        style: 'secondary',
        requiresConfirmation: false,
        riskLevel: 'low',
        description: '取消本次失败操作。'
      }]
    };
  }
  return {
    status: 'not_recoverable',
    analyzedBy: 'client',
    analyzedAt: nowIso(),
    summary: '当前错误还没有可自动执行的安全恢复方案。',
    reason: operation && operation.error ? operation.error : '未知 Jira 操作错误。',
    actions: [{ id: 'cancel', kind: 'cancel', label: '取消创建', style: 'secondary', requiresConfirmation: false, riskLevel: 'low' }]
  };
}

function issueTypeAliases(name) {
  const aliases = {
    Task: ['任务'],
    Story: ['需求'],
    Subtask: ['子任务'],
    'Sub-task': ['子任务'],
    子任务: ['Sub-task', 'Subtask'],
    任务: ['Task'],
    需求: ['Story']
  };
  return [name, ...(aliases[name] || [])].filter(Boolean);
}

async function resolveProjectDraft(config, draft, options = {}) {
  if (!draft.projectKey) {
    return draft;
  }
  try {
    const project = await requestJira(config, `/project/${encodeURIComponent(draft.projectKey)}`, options);
    const availableTypes = Array.isArray(project.issueTypes) ? project.issueTypes : [];
    const aliases = issueTypeAliases(draft.issueType || config.defaultIssueType || 'Task');
    const matchedType = availableTypes.find((type) => aliases.includes(type.name) || aliases.includes(type.id));
    return {
      ...draft,
      projectKey: project.key || draft.projectKey,
      projectName: project.name || draft.projectName,
      projectValid: true,
      ...(matchedType ? { issueType: matchedType.name, issueTypeId: matchedType.id } : {})
    };
  } catch (error) {
    if (error && error.code === 'JIRA_API_ERROR' && error.statusCode === 404) {
      return { ...draft, projectValid: false };
    }
    return draft;
  }
}

async function resolveAssigneeDraft(config, draft, options = {}) {
  if (!draft.assignee) {
    return draft;
  }
  const query = encodeURIComponent(draft.assignee);
  const pathname = config.deploymentType === 'cloud'
    ? `/user/search?query=${query}&maxResults=5`
    : `/user/search?username=${query}&maxResults=5`;
  try {
    const users = await requestJira(config, pathname, options);
    const candidates = Array.isArray(users) ? users : [];
    const matched = candidates.find((user) => [user.displayName, user.name, user.emailAddress, user.accountId]
      .filter(Boolean)
      .some((value) => value === draft.assignee || value.includes(draft.assignee))) || candidates[0];
    if (!matched) {
      return draft;
    }
    return {
      ...draft,
      assignee: matched.displayName || draft.assignee,
      assigneeName: matched.name || draft.assigneeName,
      assigneeAccountId: matched.accountId || draft.assigneeAccountId
    };
  } catch {
    return draft;
  }
}

async function resolveIssueTypeFields(config, fields, options = {}) {
  if (fields.issuetype && fields.issuetype.id) {
    return fields;
  }
  const issueTypeName = fields.issuetype && fields.issuetype.name;
  const projectKey = fields.project && fields.project.key;
  if (!issueTypeName || !projectKey) {
    return fields;
  }
  try {
    const project = await requestJira(config, `/project/${encodeURIComponent(projectKey)}`, options);
    const availableTypes = Array.isArray(project.issueTypes) ? project.issueTypes : [];
    const aliases = issueTypeAliases(issueTypeName);
    const matched = availableTypes.find((type) => aliases.includes(type.name) || aliases.includes(type.id));
    return matched ? { ...fields, issuetype: { id: matched.id } } : fields;
  } catch {
    return fields;
  }
}

function userFieldValue(config, value) {
  if (value && typeof value === 'object') {
    return value;
  }
  return config.deploymentType === 'cloud' ? { accountId: value } : { name: value };
}

function formatCustomFieldValue(config, schema = {}, value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }
  if (schema.type === 'user' || /userpicker/i.test(schema.custom || '')) {
    return userFieldValue(config, value);
  }
  if (schema.type === 'array' && (schema.items === 'user' || /multiuserpicker/i.test(schema.custom || ''))) {
    return Array.isArray(value) ? value.map((item) => userFieldValue(config, item)) : [userFieldValue(config, value)];
  }
  if (schema.type === 'option' || /select/i.test(schema.custom || '')) {
    return value && typeof value === 'object' ? value : { value };
  }
  if (schema.type === 'array' && schema.items === 'option') {
    return Array.isArray(value) ? value.map((item) => (item && typeof item === 'object' ? item : { value: item })) : [{ value }];
  }
  return value;
}

async function resolveCustomFieldSchemas(config, fields, options = {}) {
  const mappedFieldIds = Object.values(config.fieldMappings || {}).filter((fieldId) => fields[fieldId] !== undefined);
  if (mappedFieldIds.length === 0) {
    return fields;
  }
  try {
    const jiraFields = await requestJira(config, '/field', options);
    if (!Array.isArray(jiraFields)) {
      return fields;
    }
    const schemasById = new Map(jiraFields.map((field) => [field.id, field.schema || {}]));
    return mappedFieldIds.reduce((resolved, fieldId) => {
      if (!schemasById.has(fieldId)) {
        return resolved;
      }
      return { ...resolved, [fieldId]: formatCustomFieldValue(config, schemasById.get(fieldId), resolved[fieldId]) };
    }, fields);
  } catch {
    return fields;
  }
}

function buildLabelsUnsupportedError() {
  const message = "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown.";
  return jiraError('标签: 标签字段不能创建：该字段不在当前 Jira 创建界面中，或 Jira 不认识这个字段。', 'JIRA_API_ERROR', 400, {
    jira: { status: 400, errors: { labels: message }, errorMessages: [] }
  });
}

function findCreateMetadataIssueType(metadata, fields) {
  const projects = Array.isArray(metadata && metadata.projects) ? metadata.projects : [];
  const issueTypeId = fields.issuetype && fields.issuetype.id ? String(fields.issuetype.id) : null;
  const issueTypeName = fields.issuetype && fields.issuetype.name ? String(fields.issuetype.name) : null;
  for (const project of projects) {
    const issueTypes = Array.isArray(project.issuetypes) ? project.issuetypes : [];
    const matched = issueTypes.find((issueType) => (issueTypeId && String(issueType.id) === issueTypeId) || (issueTypeName && String(issueType.name) === issueTypeName));
    if (matched) {
      return matched;
    }
  }
  return null;
}

async function precheckJiraCreateFields(config, fields, options = {}) {
  if (!Array.isArray(fields.labels) || fields.labels.length === 0) {
    return;
  }
  const projectKey = fields.project && fields.project.key;
  if (!projectKey) {
    return;
  }
  const params = new URLSearchParams({ projectKeys: projectKey, expand: 'projects.issuetypes.fields' });
  if (fields.issuetype && fields.issuetype.id) {
    params.set('issuetypeIds', fields.issuetype.id);
  } else if (fields.issuetype && fields.issuetype.name) {
    params.set('issuetypeNames', fields.issuetype.name);
  }
  let metadata;
  try {
    metadata = await requestJira(config, `/issue/createmeta?${params.toString()}`, options);
  } catch {
    return;
  }
  const issueType = findCreateMetadataIssueType(metadata, fields);
  if (!issueType || !issueType.fields || typeof issueType.fields !== 'object') {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(issueType.fields, 'labels')) {
    throw buildLabelsUnsupportedError();
  }
}

function assertOperationOwner(operation, input = {}) {
  if (operation.clientId && input.clientId && operation.clientId !== input.clientId) {
    throw jiraError('Jira 操作不属于当前客户端。', 'FORBIDDEN', 403);
  }
  if (operation.conversationId && input.conversationId && operation.conversationId !== input.conversationId) {
    throw jiraError('Jira 操作不属于当前会话。', 'FORBIDDEN', 403);
  }
}

function removeLabelsFromDraft(draft) {
  const { labels, ...rest } = draft || {};
  return rest;
}

function createLocalJiraService({ userDataPath, configStore, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!userDataPath) {
    throw new Error('userDataPath is required.');
  }
  if (!configStore || typeof configStore.getConfig !== 'function') {
    throw new Error('configStore.getConfig is required.');
  }
  const storePaths = getStorePaths(userDataPath);

  async function getConfig() {
    return configStore.getConfig();
  }

  async function readIndex() {
    const index = await readJson(storePaths.indexFile, { operations: [] });
    return { operations: Array.isArray(index.operations) ? index.operations : [] };
  }

  async function writeIndex(index) {
    await writeJson(storePaths.indexFile, { operations: Array.isArray(index.operations) ? index.operations : [] });
  }

  async function updateJiraOperation(operationId, patch = {}) {
    const index = await readIndex();
    const operationIndex = index.operations.findIndex((item) => item.id === operationId);
    if (operationIndex === -1) {
      throw jiraError('Jira 操作不存在。', 'NOT_FOUND', 404);
    }
    const updated = { ...index.operations[operationIndex], ...patch, updatedAt: nowIso(now()) };
    index.operations[operationIndex] = updated;
    await writeIndex(index);
    return sanitize(updated);
  }

  async function createJiraImportDrafts(input = {}) {
    const config = await getConfig();
    let fileName;
    let rows;
    if (Array.isArray(input.drafts)) {
      fileName = readString(input.fileName) || 'jira-import.json';
      rows = input.drafts;
    } else {
      const decoded = decodeContent(input);
      fileName = decoded.fileName;
      if (/\.xlsx?$/i.test(fileName.toLowerCase())) {
        throw jiraError('xlsx 文件需要先交由 Claude 读取解析后再生成 Jira 草稿。');
      }
      rows = parseTextRows(decoded.buffer.toString('utf8'));
    }
    const drafts = rows.map((row) => normalizeDraft(row, config)).filter(Boolean);
    if (drafts.length === 0) {
      throw jiraError('没有从文件中解析到可创建的 Jira 需求单。');
    }
    const enrichedDrafts = [];
    for (const draft of drafts) {
      enrichedDrafts.push(await resolveProjectDraft(config, draft, { fetchImpl }));
    }
    return {
      fileName,
      count: enrichedDrafts.length,
      drafts: enrichedDrafts,
      warnings: mergeWarnings(buildDraftWarnings(drafts), buildDraftWarnings(enrichedDrafts))
    };
  }

  async function createJiraCreateOperation(input = {}) {
    const timestamp = now();
    const operation = {
      id: `jira-op-${crypto.randomUUID()}`,
      kind: 'jira_bulk_create',
      status: 'awaiting_confirmation',
      clientId: input.clientId || null,
      userId: input.userId || null,
      conversationId: input.conversationId || null,
      draftImport: {
        fileName: input.fileName,
        count: input.count,
        drafts: input.drafts,
        warnings: input.warnings || []
      },
      createdIssues: [],
      error: null,
      failure: null,
      recovery: null,
      createdAt: nowIso(timestamp),
      updatedAt: nowIso(timestamp)
    };
    if (Array.isArray(operation.draftImport.drafts) && operation.draftImport.drafts.some(hasProjectProblem)) {
      operation.failure = buildJiraProjectRequiredFailureContext(operation);
      operation.recovery = buildDefaultRecoveryFromFailure(operation, operation.failure);
      operation.status = 'recovery_required';
      operation.error = operation.failure.message;
      operation.draftImport.warnings = [];
    }
    const index = await readIndex();
    index.operations = index.operations.map((item) => {
      if (item.kind !== 'jira_bulk_create' || item.status !== 'awaiting_confirmation') {
        return item;
      }
      if (operation.conversationId && item.conversationId !== operation.conversationId) {
        return item;
      }
      if (operation.clientId && item.clientId && item.clientId !== operation.clientId) {
        return item;
      }
      return { ...item, status: 'superseded', updatedAt: nowIso(timestamp) };
    });
    index.operations = [operation, ...index.operations];
    await writeIndex(index);
    return sanitize(operation);
  }

  async function createJiraImportDraftsWithOperation(input = {}) {
    const draftImport = await createJiraImportDrafts(input);
    const operation = await createJiraCreateOperation({
      ...draftImport,
      clientId: input.clientId,
      userId: input.userId,
      conversationId: input.conversationId
    });
    return { ...draftImport, operation };
  }

  async function getJiraOperation(operationId) {
    const index = await readIndex();
    const operation = index.operations.find((item) => item.id === operationId);
    if (!operation) {
      throw jiraError('Jira 操作不存在。', 'NOT_FOUND', 404);
    }
    return sanitize(operation);
  }

  async function enrichJiraDrafts(drafts = []) {
    const config = await getConfig();
    const enriched = [];
    for (const draft of drafts) {
      const withProject = await resolveProjectDraft(config, draft, { fetchImpl });
      enriched.push(await resolveAssigneeDraft(config, withProject, { fetchImpl }));
    }
    return enriched;
  }

  async function updateJiraOperationDrafts(operationId, patchDraft = {}, input = {}) {
    const operation = await getJiraOperation(operationId);
    assertOperationOwner(operation, input);
    if (operation.status !== 'awaiting_confirmation') {
      throw jiraError('Jira 操作当前状态不能修改。', 'INVALID_OPERATION_STATUS', 409);
    }
    const { clientId, userId, conversationId, ...draftPatch } = patchDraft || {};
    const drafts = await enrichJiraDrafts(operation.draftImport.drafts.map((draft) => ({ ...draft, ...draftPatch })));
    return updateJiraOperation(operationId, {
      draftImport: { ...operation.draftImport, drafts, warnings: buildDraftWarnings(drafts) }
    });
  }

  async function rejectJiraOperation(operationId, input = {}) {
    const operation = await getJiraOperation(operationId);
    assertOperationOwner(operation, input);
    if (!['awaiting_confirmation', 'recovery_required'].includes(operation.status)) {
      throw jiraError('Jira 操作当前状态不能取消。', 'INVALID_OPERATION_STATUS', 409);
    }
    return updateJiraOperation(operationId, { status: 'rejected' });
  }

  async function runJiraCreateOperation(operationId, operation) {
    const config = await getConfig();
    const createdIssues = Array.isArray(operation.createdIssues) ? [...operation.createdIssues] : [];
    let currentDraft = null;
    let currentFields = null;
    let currentIndex = createdIssues.length;
    try {
      await updateJiraOperation(operationId, { status: 'running' });
      for (let index = createdIssues.length; index < operation.draftImport.drafts.length; index += 1) {
        const draft = operation.draftImport.drafts[index];
        currentDraft = draft;
        currentIndex = index;
        const issueTypeFields = await resolveIssueTypeFields(config, draftToJiraFields(draft, config), { fetchImpl });
        currentFields = await resolveCustomFieldSchemas(config, issueTypeFields, { fetchImpl });
        await precheckJiraCreateFields(config, currentFields, { fetchImpl });
        const created = await createJiraIssue(config, currentFields, { fetchImpl });
        createdIssues.push({ id: created.id, key: created.key, self: created.self, summary: draft.summary });
      }
      return updateJiraOperation(operationId, {
        status: 'created',
        createdIssues,
        error: null,
        failure: null,
        recovery: operation.recovery && operation.recovery.status === 'applied' ? operation.recovery : null
      });
    } catch (error) {
      const failure = buildJiraCreateFailureContext({ error, operation, draft: currentDraft, draftIndex: currentIndex, fields: currentFields, createdIssues });
      await updateJiraOperation(operationId, {
        status: 'failed',
        createdIssues,
        error: error.publicMessage || error.message,
        failure
      });
      throw error;
    }
  }

  async function confirmJiraOperation(operationId, input = {}) {
    const operation = await getJiraOperation(operationId);
    assertOperationOwner(operation, input);
    if (operation.status !== 'awaiting_confirmation') {
      throw jiraError('Jira 操作当前状态不能确认。', 'INVALID_OPERATION_STATUS', 409);
    }
    return updateJiraOperation(operationId, { status: 'confirmed_running', error: null, failure: null });
  }

  async function getJiraProject(input = {}) {
    const config = await getConfig();
    const projectKey = readString(input.projectKey || input.key);
    if (!projectKey) {
      throw jiraError('Jira 项目 Key 不能为空。');
    }
    return sanitizeJiraProject(await requestJira(config, `/project/${encodeURIComponent(projectKey)}`, { fetchImpl }));
  }

  async function getJiraCreateMeta(input = {}) {
    const config = await getConfig();
    const projectKey = readString(input.projectKey || input.key);
    if (!projectKey) {
      throw jiraError('Jira 项目 Key 不能为空。');
    }
    const params = new URLSearchParams({ projectKeys: projectKey, expand: 'projects.issuetypes.fields' });
    if (readString(input.issueTypeId)) {
      params.set('issuetypeIds', readString(input.issueTypeId));
    } else if (readString(input.issueType)) {
      params.set('issuetypeNames', readString(input.issueType));
    }
    return sanitizeCreateMeta(await requestJira(config, `/issue/createmeta?${params.toString()}`, { fetchImpl }));
  }

  async function searchJiraUser(input = {}) {
    const config = await getConfig();
    const query = readString(input.query || input.assignee || input.name);
    if (!query) {
      throw jiraError('Jira 用户查询条件不能为空。');
    }
    const pathname = config.deploymentType === 'cloud'
      ? `/user/search?query=${encodeURIComponent(query)}&maxResults=10`
      : `/user/search?username=${encodeURIComponent(query)}&maxResults=10`;
    return { users: sanitizeJiraUsers(await requestJira(config, pathname, { fetchImpl })) };
  }

  async function createConfirmedJiraIssue(operationId, input = {}, ownerInput = {}) {
    const operation = await getJiraOperation(operationId);
    assertOperationOwner(operation, ownerInput);
    if (!['confirmed_running', 'failed'].includes(operation.status)) {
      throw jiraError('Jira 操作当前状态不能执行创建。', 'INVALID_OPERATION_STATUS', 409);
    }
    const config = await getConfig();
    const drafts = operation.draftImport && Array.isArray(operation.draftImport.drafts) ? operation.draftImport.drafts : [];
    const index = Number.isInteger(input.draftIndex) ? input.draftIndex : Array.isArray(operation.createdIssues) ? operation.createdIssues.length : 0;
    const confirmedDraft = drafts[index];
    if (!confirmedDraft) {
      throw jiraError('Jira 草稿不存在。', 'NOT_FOUND', 404);
    }
    const draftPatch = input.draft && typeof input.draft === 'object' && !Array.isArray(input.draft) ? input.draft : {};
    const draft = { ...confirmedDraft, ...draftPatch, summary: confirmedDraft.summary };
    const baseFields = draftToJiraFields(draft, config);
    const inputFields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields : null;
    const fields = inputFields ? { ...inputFields, summary: confirmedDraft.summary } : await resolveCustomFieldSchemas(config, await resolveIssueTypeFields(config, baseFields, { fetchImpl }), { fetchImpl });
    try {
      const created = await createJiraIssue(config, fields, { fetchImpl });
      const createdIssues = [...(Array.isArray(operation.createdIssues) ? operation.createdIssues : []), summarizeCreatedIssue(created, confirmedDraft)];
      const status = createdIssues.length >= drafts.length ? 'created' : 'confirmed_running';
      const updated = await updateJiraOperation(operationId, { status, createdIssues, error: null, failure: null });
      return { createdIssue: summarizeCreatedIssue(created, confirmedDraft), operation: updated };
    } catch (error) {
      const createdIssues = Array.isArray(operation.createdIssues) ? operation.createdIssues : [];
      const failure = buildJiraCreateFailureContext({ error, operation, draft: confirmedDraft, draftIndex: index, fields, createdIssues });
      const updated = await updateJiraOperation(operationId, { status: 'failed', createdIssues, error: error.publicMessage || error.message, failure });
      return { ok: false, error: error.publicMessage || error.message, failure, operation: updated };
    }
  }

  async function attachJiraOperationRecovery(operationId, recovery) {
    const operation = await getJiraOperation(operationId);
    const safeRecovery = recovery || buildDefaultRecoveryFromFailure(operation, operation.failure);
    return updateJiraOperation(operationId, {
      status: ['available', 'needs_user_input'].includes(safeRecovery.status) ? 'recovery_required' : 'failed',
      recovery: safeRecovery
    });
  }

  async function recoverJiraOperation(operationId, input = {}) {
    const operation = await getJiraOperation(operationId);
    assertOperationOwner(operation, input);
    if (operation.status === 'failed' && !operation.recovery) {
      await attachJiraOperationRecovery(operationId, null);
      return recoverJiraOperation(operationId, input);
    }
    if (operation.status !== 'recovery_required') {
      throw jiraError('Jira 操作当前状态不能执行恢复。', 'INVALID_OPERATION_STATUS', 409);
    }
    const actionId = input.actionId;
    if (actionId === 'cancel') {
      return updateJiraOperation(operationId, {
        status: 'rejected',
        recovery: { ...(operation.recovery || {}), status: 'cancelled', selectedActionId: actionId, appliedAt: nowIso() }
      });
    }
    if (actionId === 'submit_supplement') {
      if (!operation.failure || !operation.failure.classification || operation.failure.classification.safeDefaultRecovery !== 'submit_supplement') {
        throw jiraError('当前 Jira 错误不能提交补充信息。', 'VALIDATION_ERROR', 400);
      }
      const projectKey = input.projectKey || (input.inputs && input.inputs.projectKey);
      if (!projectKey || typeof projectKey !== 'string' || projectKey.trim() === '') {
        throw jiraError('项目 Key 不能为空。', 'VALIDATION_ERROR', 400);
      }
      const patchedDrafts = operation.draftImport.drafts.map((draft) => (hasProjectProblem(draft) ? { ...draft, projectKey: projectKey.trim().toUpperCase(), projectValid: undefined } : draft));
      const drafts = await enrichJiraDrafts(patchedDrafts);
      return updateJiraOperation(operationId, {
        status: 'awaiting_confirmation',
        draftImport: { ...operation.draftImport, drafts, warnings: buildDraftWarnings(drafts) },
        error: null,
        failure: null,
        recovery: { ...(operation.recovery || {}), status: 'applied', selectedActionId: actionId, appliedAt: nowIso() }
      });
    }
    if (actionId !== 'retry_without_labels') {
      throw jiraError('不支持这个 Jira 恢复操作。', 'VALIDATION_ERROR', 400);
    }
    if (!operation.failure || !operation.failure.classification || operation.failure.classification.safeDefaultRecovery !== 'retry_without_labels') {
      throw jiraError('当前 Jira 错误不能移除标签后重试。', 'VALIDATION_ERROR', 400);
    }
    const startIndex = Array.isArray(operation.createdIssues) ? operation.createdIssues.length : 0;
    const drafts = operation.draftImport.drafts.map((draft, index) => (index >= startIndex ? removeLabelsFromDraft(draft) : draft));
    const patched = await updateJiraOperation(operationId, {
      draftImport: { ...operation.draftImport, drafts, warnings: buildDraftWarnings(drafts) },
      recovery: { ...(operation.recovery || {}), status: 'applied', selectedActionId: actionId, appliedAt: nowIso() }
    });
    return runJiraCreateOperation(operationId, patched);
  }

  return {
    createJiraImportDrafts,
    createJiraImportDraftsWithOperation,
    createJiraCreateOperation,
    getJiraOperation,
    enrichJiraDrafts,
    updateJiraOperationDrafts,
    confirmJiraOperation,
    getJiraProject,
    getJiraCreateMeta,
    searchJiraUser,
    createConfirmedJiraIssue,
    rejectJiraOperation,
    attachJiraOperationRecovery,
    recoverJiraOperation
  };
}

module.exports = {
  createLocalJiraService,
  parseTextRows,
  normalizeDraft,
  draftToJiraFields,
  requestJira,
  jiraError,
  buildDefaultRecoveryFromFailure
};
