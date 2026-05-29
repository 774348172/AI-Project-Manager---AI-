const crypto = require('crypto');
const path = require('path');
const paths = require('../config/paths');
const { readJsonIfExists, writeJson } = require('../lib/file-store');
const { getJiraConfig } = require('./config-service');
const { createJiraIssue, jiraError, requestJira, classifyJiraApiError } = require('./jira-client-service');
const { draftToJiraFields } = require('./jira-import-service');

function nowIso(now = new Date()) {
  return now.toISOString();
}

function getStorePaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'runtime', 'jira-operations');
  return {
    root,
    indexFile: path.join(root, 'index.json')
  };
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

async function readIndex(baizeRoot) {
  const store = getStorePaths(baizeRoot);
  return readJsonIfExists(store.indexFile, { operations: [] });
}

async function writeIndex(index, baizeRoot) {
  const store = getStorePaths(baizeRoot);
  await writeJson(store.indexFile, index, store.root);
}

async function createJiraCreateOperation(input = {}, options = {}) {
  const now = options.now || new Date();
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
    createdAt: nowIso(now),
    updatedAt: nowIso(now)
  };
  if (Array.isArray(operation.draftImport.drafts) && operation.draftImport.drafts.some((draft) => !draft.projectKey)) {
    operation.failure = buildJiraProjectRequiredFailureContext(operation);
    operation.recovery = buildDefaultRecoveryFromFailure(operation, operation.failure);
    operation.status = 'recovery_required';
    operation.error = operation.failure.message;
    operation.draftImport.warnings = [];
  }
  const index = await readIndex(options.baizeRoot);
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
    return { ...item, status: 'superseded', updatedAt: nowIso(now) };
  });
  index.operations = [operation, ...index.operations];
  await writeIndex(index, options.baizeRoot);
  return sanitize(operation);
}

async function getJiraOperation(operationId, options = {}) {
  const index = await readIndex(options.baizeRoot);
  const operation = index.operations.find((item) => item.id === operationId);
  if (!operation) {
    throw jiraError('Jira 操作不存在。', 'NOT_FOUND', 404);
  }
  return sanitize(operation);
}

async function getLatestAwaitingJiraOperation(input = {}, options = {}) {
  if (!input.conversationId) {
    return null;
  }
  const index = await readIndex(options.baizeRoot);
  const operation = index.operations.find((item) => item.kind === 'jira_bulk_create'
    && item.status === 'awaiting_confirmation'
    && item.conversationId === input.conversationId
    && (!input.clientId || !item.clientId || item.clientId === input.clientId));
  return sanitize(operation || null);
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

async function resolveProjectDraft(config, draft, options = {}) {
  if (!draft.projectKey) {
    return draft;
  }
  try {
    const project = await requestJira(config, `/project/${encodeURIComponent(draft.projectKey)}`, { fetchImpl: options.fetchImpl });
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
  } catch {
    return { ...draft, projectValid: false };
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
    const users = await requestJira(config, pathname, { fetchImpl: options.fetchImpl });
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

async function enrichJiraDrafts(drafts = [], options = {}) {
  const config = await getJiraConfig(options);
  const enriched = [];
  for (const draft of drafts) {
    const withProject = await resolveProjectDraft(config, draft, options);
    enriched.push(await resolveAssigneeDraft(config, withProject, options));
  }
  return enriched;
}

async function updateJiraOperationDrafts(operationId, patchDraft, options = {}) {
  const operation = await getJiraOperation(operationId, options);
  if (operation.status !== 'awaiting_confirmation') {
    throw jiraError('Jira 操作当前状态不能修改。', 'INVALID_OPERATION_STATUS', 409);
  }
  const drafts = await enrichJiraDrafts(operation.draftImport.drafts.map((draft) => ({ ...draft, ...patchDraft })), options);
  return updateJiraOperation(operationId, {
    draftImport: {
      ...operation.draftImport,
      drafts,
      warnings: buildDraftWarnings(drafts)
    }
  }, options);
}

async function updateJiraOperation(operationId, patch = {}, options = {}) {
  const index = await readIndex(options.baizeRoot);
  const operationIndex = index.operations.findIndex((item) => item.id === operationId);
  if (operationIndex === -1) {
    throw jiraError('Jira 操作不存在。', 'NOT_FOUND', 404);
  }
  const updated = {
    ...index.operations[operationIndex],
    ...patch,
    updatedAt: nowIso(options.now || new Date())
  };
  index.operations[operationIndex] = updated;
  await writeIndex(index, options.baizeRoot);
  return sanitize(updated);
}

function assertOperationOwner(operation, input = {}) {
  if (operation.clientId && input.clientId && operation.clientId !== input.clientId) {
    throw jiraError('Jira 操作不属于当前客户端。', 'FORBIDDEN', 403);
  }
  if (operation.conversationId && input.conversationId && operation.conversationId !== input.conversationId) {
    throw jiraError('Jira 操作不属于当前会话。', 'FORBIDDEN', 403);
  }
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

function buildJiraProjectRequiredFailureContext(operation) {
  const drafts = operation.draftImport && Array.isArray(operation.draftImport.drafts) ? operation.draftImport.drafts : [];
  return {
    plugin: 'jira',
    operationKind: operation.kind,
    code: 'JIRA_PROJECT_REQUIRED',
    statusCode: 409,
    message: '存在未配置项目 Key 的草稿，确认创建前需要补充项目。',
    failedAt: nowIso(),
    failedDraftIndex: drafts.findIndex((draft) => !draft.projectKey),
    createdCount: Array.isArray(operation.createdIssues) ? operation.createdIssues.length : 0,
    retryable: false,
    requiresUserInput: true,
    classification: {
      type: 'missing_required_field',
      field: 'projectKey',
      safeDefaultRecovery: 'submit_supplement'
    },
    sanitizedRequestContext: {
      draftCount: drafts.length,
      missingProjectKeyCount: drafts.filter((draft) => !draft.projectKey).length,
      draftsMissingProjectKey: drafts.map((draft, index) => ({ index, draft })).filter((item) => !item.draft.projectKey).map((item) => ({
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
    return {
      status: 'needs_user_input',
      analyzedBy: 'server',
      analyzedAt: nowIso(),
      summary: '创建 Jira 前需要补充项目 Key。',
      reason: 'Jira 创建必须知道每个草稿要写入哪个项目；当前有草稿缺少 projectKey。',
      supplement: {
        prompt: '请填写这些 Jira 单要创建到哪个项目 Key。',
        inputs: [{
          id: 'projectKey',
          type: 'text',
          label: '项目 Key',
          required: true
        }],
        actions: [{
          id: 'submit_supplement',
          kind: 'submit',
          label: '提交项目 Key',
          style: 'primary',
          requiresConfirmation: false,
          riskLevel: 'low'
        }]
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
      analyzedBy: 'server',
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
    analyzedBy: 'server',
    analyzedAt: nowIso(),
    summary: '当前错误还没有可自动执行的安全恢复方案。',
    reason: operation && operation.error ? operation.error : '未知 Jira 操作错误。',
    actions: [{
      id: 'cancel',
      kind: 'cancel',
      label: '取消创建',
      style: 'secondary',
      requiresConfirmation: false,
      riskLevel: 'low'
    }]
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
    const project = await requestJira(config, `/project/${encodeURIComponent(projectKey)}`, { fetchImpl: options.fetchImpl });
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
    return Array.isArray(value)
      ? value.map((item) => userFieldValue(config, item))
      : [userFieldValue(config, value)];
  }
  if (schema.type === 'option' || /select/i.test(schema.custom || '')) {
    return value && typeof value === 'object' ? value : { value };
  }
  if (schema.type === 'array' && schema.items === 'option') {
    return Array.isArray(value)
      ? value.map((item) => (item && typeof item === 'object' ? item : { value: item }))
      : [{ value }];
  }
  return value;
}

async function resolveCustomFieldSchemas(config, fields, options = {}) {
  const mappedFieldIds = Object.values(config.fieldMappings || {}).filter((fieldId) => fields[fieldId] !== undefined);
  if (mappedFieldIds.length === 0) {
    return fields;
  }
  try {
    const jiraFields = await requestJira(config, '/field', { fetchImpl: options.fetchImpl });
    if (!Array.isArray(jiraFields)) {
      return fields;
    }
    const schemasById = new Map(jiraFields.map((field) => [field.id, field.schema || {}]));
    return mappedFieldIds.reduce((resolved, fieldId) => {
      if (!schemasById.has(fieldId)) {
        return resolved;
      }
      return {
        ...resolved,
        [fieldId]: formatCustomFieldValue(config, schemasById.get(fieldId), resolved[fieldId])
      };
    }, fields);
  } catch {
    return fields;
  }
}

function buildLabelsUnsupportedError() {
  const message = "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown.";
  return jiraError('标签: 标签字段不能创建：该字段不在当前 Jira 创建界面中，或 Jira 不认识这个字段。', 'JIRA_API_ERROR', 400, {
    jira: {
      status: 400,
      errors: { labels: message },
      errorMessages: []
    }
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
  const params = new URLSearchParams({
    projectKeys: projectKey,
    expand: 'projects.issuetypes.fields'
  });
  if (fields.issuetype && fields.issuetype.id) {
    params.set('issuetypeIds', fields.issuetype.id);
  } else if (fields.issuetype && fields.issuetype.name) {
    params.set('issuetypeNames', fields.issuetype.name);
  }
  let metadata;
  try {
    metadata = await requestJira(config, `/issue/createmeta?${params.toString()}`, { fetchImpl: options.fetchImpl });
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

async function rejectJiraOperation(operationId, input = {}, options = {}) {
  const operation = await getJiraOperation(operationId, options);
  assertOperationOwner(operation, input);
  if (operation.status !== 'awaiting_confirmation') {
    throw jiraError('Jira 操作当前状态不能取消。', 'INVALID_OPERATION_STATUS', 409);
  }
  return updateJiraOperation(operationId, { status: 'rejected' }, options);
}

async function runJiraCreateOperation(operationId, operation, options = {}) {
  const config = await getJiraConfig(options);
  const createdIssues = Array.isArray(operation.createdIssues) ? [...operation.createdIssues] : [];
  let currentDraft = null;
  let currentFields = null;
  let currentIndex = createdIssues.length;
  try {
    await updateJiraOperation(operationId, { status: 'running' }, options);
    for (let index = createdIssues.length; index < operation.draftImport.drafts.length; index += 1) {
      const draft = operation.draftImport.drafts[index];
      currentDraft = draft;
      currentIndex = index;
      const issueTypeFields = await resolveIssueTypeFields(config, draftToJiraFields(draft, config), { fetchImpl: options.fetchImpl });
      currentFields = await resolveCustomFieldSchemas(config, issueTypeFields, { fetchImpl: options.fetchImpl });
      await precheckJiraCreateFields(config, currentFields, { fetchImpl: options.fetchImpl });
      const created = await createJiraIssue(config, currentFields, { fetchImpl: options.fetchImpl });
      createdIssues.push({ id: created.id, key: created.key, self: created.self, summary: draft.summary });
    }
    return updateJiraOperation(operationId, {
      status: 'created',
      createdIssues,
      error: null,
      failure: null,
      recovery: operation.recovery && operation.recovery.status === 'applied' ? operation.recovery : null
    }, options);
  } catch (error) {
    const failure = buildJiraCreateFailureContext({
      error,
      operation,
      draft: currentDraft,
      draftIndex: currentIndex,
      fields: currentFields,
      createdIssues
    });
    await updateJiraOperation(operationId, {
      status: 'failed',
      createdIssues,
      error: error.publicMessage || error.message,
      failure
    }, options);
    throw error;
  }
}

async function confirmJiraOperation(operationId, input = {}, options = {}) {
  const operation = await getJiraOperation(operationId, options);
  assertOperationOwner(operation, input);
  if (operation.status !== 'awaiting_confirmation') {
    throw jiraError('Jira 操作当前状态不能确认。', 'INVALID_OPERATION_STATUS', 409);
  }

  return runJiraCreateOperation(operationId, operation, options);
}

async function markJiraOperationProjectRequired(operationId, input = {}, options = {}) {
  const operation = await getJiraOperation(operationId, options);
  assertOperationOwner(operation, input);
  if (operation.status !== 'awaiting_confirmation') {
    throw jiraError('Jira 操作当前状态不能补充项目信息。', 'INVALID_OPERATION_STATUS', 409);
  }
  const drafts = operation.draftImport && Array.isArray(operation.draftImport.drafts) ? operation.draftImport.drafts : [];
  if (!drafts.some((draft) => !draft.projectKey)) {
    return operation;
  }
  return updateJiraOperation(operationId, {
    status: 'failed',
    error: '存在未配置项目 Key 的草稿，确认创建前需要补充项目。',
    failure: buildJiraProjectRequiredFailureContext(operation)
  }, options);
}

async function attachJiraOperationRecovery(operationId, recovery, options = {}) {
  const operation = await getJiraOperation(operationId, options);
  const safeRecovery = recovery || buildDefaultRecoveryFromFailure(operation, operation.failure);
  return updateJiraOperation(operationId, {
    status: ['available', 'needs_user_input'].includes(safeRecovery.status) ? 'recovery_required' : 'failed',
    recovery: safeRecovery
  }, options);
}

function removeLabelsFromDraft(draft) {
  const { labels, ...rest } = draft || {};
  return rest;
}

async function applyJiraOperationRecovery(operationId, input = {}, options = {}) {
  const operation = await getJiraOperation(operationId, options);
  assertOperationOwner(operation, input);
  if (operation.status !== 'recovery_required') {
    throw jiraError('Jira 操作当前状态不能执行恢复。', 'INVALID_OPERATION_STATUS', 409);
  }
  const actionId = input.actionId;
  if (actionId === 'cancel') {
    return updateJiraOperation(operationId, {
      status: 'rejected',
      recovery: {
        ...(operation.recovery || {}),
        status: 'cancelled',
        selectedActionId: actionId,
        appliedAt: nowIso()
      }
    }, options);
  }
  if (actionId === 'submit_supplement') {
    if (!operation.failure || !operation.failure.classification || operation.failure.classification.safeDefaultRecovery !== 'submit_supplement') {
      throw jiraError('当前 Jira 错误不能提交补充信息。', 'VALIDATION_ERROR', 400);
    }
    const projectKey = input.projectKey || (input.inputs && input.inputs.projectKey);
    if (!projectKey || typeof projectKey !== 'string' || projectKey.trim() === '') {
      throw jiraError('项目 Key 不能为空。', 'VALIDATION_ERROR', 400);
    }
    const patchedDrafts = operation.draftImport.drafts.map((draft) => (draft.projectKey ? draft : { ...draft, projectKey: projectKey.trim().toUpperCase() }));
    const drafts = await enrichJiraDrafts(patchedDrafts, options);
    return updateJiraOperation(operationId, {
      status: 'awaiting_confirmation',
      draftImport: {
        ...operation.draftImport,
        drafts,
        warnings: buildDraftWarnings(drafts)
      },
      error: null,
      failure: null,
      recovery: {
        ...(operation.recovery || {}),
        status: 'applied',
        selectedActionId: actionId,
        appliedAt: nowIso()
      }
    }, options);
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
    draftImport: {
      ...operation.draftImport,
      drafts,
      warnings: buildDraftWarnings(drafts)
    },
    recovery: {
      ...(operation.recovery || {}),
      status: 'applied',
      selectedActionId: actionId,
      appliedAt: nowIso()
    }
  }, options);
  return runJiraCreateOperation(operationId, patched, options);
}

module.exports = {
  createJiraCreateOperation,
  getJiraOperation,
  getLatestAwaitingJiraOperation,
  enrichJiraDrafts,
  updateJiraOperationDrafts,
  confirmJiraOperation,
  markJiraOperationProjectRequired,
  attachJiraOperationRecovery,
  applyJiraOperationRecovery,
  buildDefaultRecoveryFromFailure,
  rejectJiraOperation
};
