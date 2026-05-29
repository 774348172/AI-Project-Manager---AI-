const crypto = require('crypto');
const path = require('path');
const paths = require('../config/paths');
const { readJsonIfExists, writeJson } = require('../lib/file-store');
const { assertSafeId } = require('./conversation-service');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const VALID_STATUSES = new Set([
  'awaiting_confirmation',
  'confirmed',
  'running',
  'awaiting_local_apply',
  'rejected',
  'expired',
  'failed',
  'applied',
  'apply_failed'
]);

function operationError(message, code = 'VALIDATION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function getOperationPaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'runtime', 'pending-operations');
  return {
    root,
    indexFile: path.join(root, 'index.json')
  };
}

function generateOperationId() {
  return `op-${crypto.randomUUID()}`;
}

function sanitizeOperation(operation) {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    conversationId: operation.conversationId,
    clientId: operation.clientId,
    userId: operation.userId,
    platform: operation.platform,
    requestedBy: operation.requestedBy,
    intent: operation.intent,
    permission: operation.permission,
    risk: operation.risk,
    proposal: operation.proposal,
    application: operation.application,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    expiresAt: operation.expiresAt
  };
}

async function readIndex(baizeRoot) {
  const operationPaths = getOperationPaths(baizeRoot);
  return readJsonIfExists(operationPaths.indexFile, { operations: [] });
}

async function writeIndex(index, baizeRoot) {
  const operationPaths = getOperationPaths(baizeRoot);
  await writeJson(operationPaths.indexFile, index, operationPaths.root);
}

async function listOperations({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const index = await readIndex(baizeRoot);
  return index.operations.map(sanitizeOperation);
}

async function createPendingOperation(input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const timestamp = nowIso(now);
  const operation = {
    id: generateOperationId(),
    kind: input.kind || 'claude_code_patch',
    status: 'awaiting_confirmation',
    conversationId: assertSafeId(input.conversationId, 'conversationId'),
    clientId: typeof input.clientId === 'string' && input.clientId.trim() !== '' ? input.clientId.trim() : null,
    userId: typeof input.userId === 'string' && input.userId.trim() !== '' ? input.userId.trim() : null,
    platform: typeof input.platform === 'string' && input.platform.trim() !== '' ? input.platform.trim() : 'desktop',
    requestedBy: {
      text: input.text || '',
      userId: typeof input.userId === 'string' ? input.userId : null
    },
    intent: input.intent || null,
    permission: {
      mode: input.permissionMode || 'write_proposal',
      requireConfirmation: true,
      confirmedAt: null,
      rejectedAt: null
    },
    risk: {
      level: input.riskLevel || 'medium',
      reasons: Array.isArray(input.riskReasons) ? input.riskReasons : [],
      blocked: false
    },
    proposal: {
      summary: null,
      patch: null,
      files: [],
      warnings: []
    },
    application: {
      target: 'desktop_local_workspace',
      status: 'not_applied',
      appliedAt: null,
      appliedByClientId: null,
      appliedFiles: [],
      error: null
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: nowIso(new Date(now.getTime() + ttlMs))
  };

  const index = await readIndex(baizeRoot);
  index.operations = [operation, ...index.operations];
  await writeIndex(index, baizeRoot);
  return sanitizeOperation(operation);
}

async function getOperation(operationId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const id = assertSafeId(operationId, 'operationId');
  const index = await readIndex(baizeRoot);
  const operation = index.operations.find((item) => item.id === id);
  if (!operation) {
    throw operationError('操作不存在。', 'NOT_FOUND', 404);
  }

  return sanitizeOperation(operation);
}

async function updateOperation(operationId, patch = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const id = assertSafeId(operationId, 'operationId');
  const index = await readIndex(baizeRoot);
  const operationIndex = index.operations.findIndex((item) => item.id === id);
  if (operationIndex === -1) {
    throw operationError('操作不存在。', 'NOT_FOUND', 404);
  }
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    throw operationError('操作状态无效。');
  }

  const current = index.operations[operationIndex];
  const updated = {
    ...current,
    ...patch,
    permission: patch.permission ? { ...current.permission, ...patch.permission } : current.permission,
    risk: patch.risk ? { ...current.risk, ...patch.risk } : current.risk,
    proposal: patch.proposal ? { ...current.proposal, ...patch.proposal } : current.proposal,
    application: patch.application ? { ...current.application, ...patch.application } : current.application,
    updatedAt: nowIso(now)
  };

  index.operations[operationIndex] = updated;
  await writeIndex(index, baizeRoot);
  return sanitizeOperation(updated);
}

function assertOperationMatches(operation, { conversationId, clientId } = {}) {
  if (conversationId && operation.conversationId && conversationId !== operation.conversationId) {
    throw operationError('操作不属于当前会话。', 'FORBIDDEN', 403);
  }
  if (clientId && operation.clientId && clientId !== operation.clientId) {
    throw operationError('操作不属于当前客户端。', 'FORBIDDEN', 403);
  }
}

function assertOperationActive(operation, now = new Date()) {
  if (new Date(operation.expiresAt).getTime() <= now.getTime()) {
    throw operationError('操作已过期。', 'OPERATION_EXPIRED', 409);
  }
  if (operation.status !== 'awaiting_confirmation') {
    throw operationError('操作当前状态不能确认。', 'INVALID_OPERATION_STATUS', 409);
  }
}

async function confirmOperation(operationId, input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const operation = await getOperation(operationId, { baizeRoot });
  assertOperationMatches(operation, input);
  assertOperationActive(operation, now);
  return updateOperation(operation.id, {
    status: 'confirmed',
    permission: { confirmedAt: nowIso(now) }
  }, { baizeRoot, now });
}

async function rejectOperation(operationId, input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const operation = await getOperation(operationId, { baizeRoot });
  assertOperationMatches(operation, input);
  if (['applied', 'rejected'].includes(operation.status)) {
    throw operationError('操作当前状态不能取消。', 'INVALID_OPERATION_STATUS', 409);
  }
  return updateOperation(operation.id, {
    status: 'rejected',
    permission: { rejectedAt: nowIso(now) }
  }, { baizeRoot, now });
}

async function recordApplicationResult(operationId, input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const operation = await getOperation(operationId, { baizeRoot });
  assertOperationMatches(operation, input);
  const applied = input.status === 'applied';
  return updateOperation(operation.id, {
    status: applied ? 'applied' : 'apply_failed',
    application: {
      status: applied ? 'applied' : 'apply_failed',
      appliedAt: nowIso(now),
      appliedByClientId: input.clientId || null,
      appliedFiles: Array.isArray(input.appliedFiles) ? input.appliedFiles : [],
      error: applied ? null : input.error || '本地补丁应用失败。'
    }
  }, { baizeRoot, now });
}

module.exports = {
  createPendingOperation,
  getOperation,
  listOperations,
  updateOperation,
  confirmOperation,
  rejectOperation,
  recordApplicationResult
};
