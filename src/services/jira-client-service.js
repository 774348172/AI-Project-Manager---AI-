const { getJiraConfig, getPublicJiraConfig } = require('./config-service');

function jiraError(message, code = 'VALIDATION_ERROR', statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  Object.assign(error, details);
  return error;
}

function trimString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeBaseUrl(baseURL) {
  const value = trimString(baseURL);
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

function assertJiraReady(config) {
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
    return {
      type: 'field_not_on_create_screen',
      field: 'labels',
      safeDefaultRecovery: 'retry_without_labels'
    };
  }
  return {
    type: 'unknown',
    field: null,
    safeDefaultRecovery: null
  };
}

function sanitizeJiraApiError(error = {}) {
  const jira = error.jira && typeof error.jira === 'object' ? error.jira : {};
  return {
    code: trimString(error.code) || 'UNKNOWN_ERROR',
    statusCode: Number.isInteger(error.statusCode) ? error.statusCode : undefined,
    message: trimString(error.publicMessage) || trimString(error.message) || 'Jira 请求失败。',
    jira: {
      status: Number.isInteger(jira.status) ? jira.status : undefined,
      errorMessages: Array.isArray(jira.errorMessages) ? jira.errorMessages.map(trimString).filter(Boolean).slice(0, 20) : [],
      errors: jira.errors && typeof jira.errors === 'object' && !Array.isArray(jira.errors)
        ? Object.fromEntries(Object.entries(jira.errors).map(([key, value]) => [key, String(value || '').slice(0, 500)]).slice(0, 50))
        : {}
    }
  };
}

function classifyJiraSearchApiError(error = {}) {
  const safe = sanitizeJiraApiError(error);
  const text = [
    safe.message,
    ...(safe.jira.errorMessages || []),
    ...Object.entries(safe.jira.errors || {}).flatMap(([field, message]) => [field, message])
  ].join(' ');
  if (error.code === 'JIRA_REQUEST_TIMEOUT') {
    return { type: 'timeout' };
  }
  if (/(?:permission|permissions|not have|does not exist|项目|project)/i.test(text) && /(?:project|项目)/i.test(text)) {
    return { type: 'permission_or_project' };
  }
  if (/(?:field|字段|Field).*?(?:does not exist|不存在|cannot be found|不存在)/i.test(text) || /(?:labels|assignee|status|issuetype|任务负责人)/i.test(text) && /(?:字段|field|不存在)/i.test(text)) {
    return { type: 'invalid_field' };
  }
  if (/(?:does not exist for the field|没有.*值|value|值)/i.test(text)) {
    return { type: 'invalid_value' };
  }
  if (/(?:jql|JQL|语法|syntax|ORDER BY|operator|was expecting)/i.test(text)) {
    return { type: 'invalid_jql' };
  }
  return { type: 'unknown' };
}

const JIRA_REQUEST_TIMEOUT_MS = 30000;

async function requestJira(config, pathname, { method = 'GET', body, fetchImpl = fetch, timeoutMs = JIRA_REQUEST_TIMEOUT_MS } = {}) {
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

async function getJiraStatus(options = {}) {
  const config = await getJiraConfig(options);
  const publicConfig = await getPublicJiraConfig(options);
  return {
    implemented: true,
    enabled: publicConfig.enabled,
    baseURL: publicConfig.baseURL,
    apiVersion: publicConfig.apiVersion,
    authType: publicConfig.authType,
    credentialConfigured: publicConfig.credentialConfigured,
    defaultProjectKey: publicConfig.defaultProjectKey,
    defaultIssueType: publicConfig.defaultIssueType,
    fieldMappingsConfigured: publicConfig.fieldMappingsConfigured,
    deploymentType: publicConfig.deploymentType,
    ready: Boolean(config.enabled && config.baseURL && ((config.authType === 'bearer' && config.apiToken) || (config.authType === 'basic' && (config.username || config.email) && (config.password || config.apiToken))))
  };
}

async function searchJira(config, { jql, fields, maxResults = 50, fetchImpl, timeoutMs } = {}) {
  const defaultFields = ['summary', 'status', 'assignee', 'issuetype', 'project', 'priority', 'created', 'updated'];
  const allowedFields = new Set([...defaultFields, 'resolutiondate', 'statuscategorychangedate']);
  const requestedFields = Array.isArray(fields)
    ? fields.map(trimString).filter((field) => field && allowedFields.has(field))
    : [];
  return requestJira(config, '/search', {
    method: 'POST',
    fetchImpl,
    timeoutMs,
    body: {
      jql,
      maxResults,
      fields: requestedFields.length > 0 ? requestedFields : defaultFields
    }
  });
}

async function createJiraIssue(config, fields, { fetchImpl } = {}) {
  return requestJira(config, '/issue', {
    method: 'POST',
    fetchImpl,
    body: { fields }
  });
}

async function addJiraComment(config, issueKey, body, { fetchImpl } = {}) {
  return requestJira(config, `/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    fetchImpl,
    body: { body }
  });
}

async function listJiraComments(config, issueKey, { fetchImpl } = {}) {
  const data = await requestJira(config, `/issue/${encodeURIComponent(issueKey)}/comment?maxResults=200`, { fetchImpl });
  return Array.isArray(data && data.comments) ? data.comments : [];
}

async function deleteJiraComment(config, issueKey, commentId, { fetchImpl } = {}) {
  return requestJira(config, `/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
    fetchImpl
  });
}

async function updateJiraIssue(config, issueKey, fields, { fetchImpl } = {}) {
  return requestJira(config, `/issue/${encodeURIComponent(issueKey)}`, {
    method: 'PUT',
    fetchImpl,
    body: { fields: fields || {} }
  });
}

async function listJiraTransitions(config, issueKey, { fetchImpl } = {}) {
  const data = await requestJira(config, `/issue/${encodeURIComponent(issueKey)}/transitions`, { fetchImpl });
  return Array.isArray(data && data.transitions) ? data.transitions : [];
}

async function transitionJiraIssue(config, issueKey, transition, { fetchImpl } = {}) {
  const body = transition && transition.id
    ? { transition: { id: String(transition.id) } }
    : { transition: { name: transition && transition.name } };
  return requestJira(config, `/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    fetchImpl,
    body
  });
}

async function deleteJiraIssue(config, issueKey, { fetchImpl } = {}) {
  return requestJira(config, `/issue/${encodeURIComponent(issueKey)}`, {
    method: 'DELETE',
    fetchImpl
  });
}

async function deleteJiraAuthorComments(config, issueKey, authorIdentifiers, { fetchImpl, predicate } = {}) {
  const comments = await listJiraComments(config, issueKey, { fetchImpl });
  const normalizedAuthors = new Set((authorIdentifiers || []).map((value) => String(value || '').toLowerCase()).filter(Boolean));
  const isMatch = (comment) => {
    const author = comment && comment.author;
    if (!author) {
      return false;
    }
    const candidates = [author.name, author.key, author.accountId, author.emailAddress].map((value) => String(value || '').toLowerCase()).filter(Boolean);
    const authorHit = candidates.some((candidate) => normalizedAuthors.has(candidate));
    if (!authorHit) {
      return false;
    }
    return typeof predicate === 'function' ? Boolean(predicate(comment)) : true;
  };
  const targets = comments.filter(isMatch);
  const deleted = [];
  const failed = [];
  for (const comment of targets) {
    try {
      await deleteJiraComment(config, issueKey, comment.id, { fetchImpl });
      deleted.push({ id: comment.id, body: comment.body || '' });
    } catch (error) {
      failed.push({ id: comment.id, error: error.publicMessage || error.message || '未知错误' });
    }
  }
  return { issueKey, scanned: comments.length, matched: targets.length, deleted, failed };
}

module.exports = {
  jiraError,
  getJiraStatus,
  searchJira,
  createJiraIssue,
  addJiraComment,
  listJiraComments,
  deleteJiraComment,
  deleteJiraAuthorComments,
  updateJiraIssue,
  listJiraTransitions,
  transitionJiraIssue,
  deleteJiraIssue,
  requestJira,
  formatJiraApiError,
  classifyJiraApiError,
  sanitizeJiraApiError,
  classifyJiraSearchApiError
};
