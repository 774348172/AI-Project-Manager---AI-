const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const paths = require('../config/paths');
const { writeJson, readJsonIfExists } = require('../lib/file-store');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function getStoreRoot(baizeRoot = paths.BAIZE_ROOT) {
  return path.join(baizeRoot, 'runtime', 'audit-pending');
}

function fileFor(auditId, baizeRoot) {
  return path.join(getStoreRoot(baizeRoot), `${auditId}.json`);
}

function generateAuditId() {
  return `audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function createPendingAudit(input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const auditId = generateAuditId();
  const issuedAt = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const record = {
    auditId,
    plugin: input.plugin || null,
    kind: input.kind || null,
    triggerSource: input.triggerSource || 'client',
    intent: input.intent || null,
    audit: input.audit || null,
    requester: input.requester || null,
    issuedAt,
    expiresAt,
    status: 'awaiting_confirmation'
  };
  const root = getStoreRoot(baizeRoot);
  await writeJson(fileFor(auditId, baizeRoot), record, root);
  return record;
}

async function getPendingAudit(auditId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  if (!auditId || typeof auditId !== 'string') {
    return null;
  }
  return readJsonIfExists(fileFor(auditId, baizeRoot), null);
}

async function deletePendingAudit(auditId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  if (!auditId) {
    return false;
  }
  try {
    await fs.unlink(fileFor(auditId, baizeRoot));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function markPendingAuditStatus(auditId, status, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const record = await getPendingAudit(auditId, { baizeRoot });
  if (!record) {
    return null;
  }
  record.status = status;
  record.updatedAt = now instanceof Date ? now.toISOString() : new Date().toISOString();
  await writeJson(fileFor(auditId, baizeRoot), record, getStoreRoot(baizeRoot));
  return record;
}

module.exports = {
  createPendingAudit,
  getPendingAudit,
  deletePendingAudit,
  markPendingAuditStatus
};
