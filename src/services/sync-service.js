const crypto = require('crypto');
const path = require('path');
const paths = require('../config/paths');
const { appendJsonLine, readJsonIfExists, readJsonLinesIfExists, writeJson } = require('../lib/file-store');

const SYNC_EVENT_TYPES = new Set([
  'memory.created',
  'memory.updated',
  'logic_assertion.created',
  'logic_assertion.updated',
  'audit.created',
  'audit.updated',
  'plugin.updated',
  'client_runtime.updated'
]);

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function syncPaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'runtime', 'sync-events');
  return {
    root,
    indexFile: path.join(root, 'index.json'),
    eventsFile: path.join(root, 'events.jsonl')
  };
}

function normalizeString(value, fieldName, maxLength = 500) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${fieldName} is required.`);
  }
  return value.trim().slice(0, maxLength);
}

function normalizeClientEvent(input = {}) {
  const type = normalizeString(input.type, 'type', 100);
  if (!SYNC_EVENT_TYPES.has(type)) {
    throw validationError('Unsupported sync event type.');
  }
  const clientId = normalizeString(input.clientId, 'clientId', 120);
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? input.payload
    : null;
  if (!payload) {
    throw validationError('payload is required.');
  }

  return {
    type,
    clientId,
    userId: typeof input.userId === 'string' ? input.userId.trim().slice(0, 120) : '',
    payload,
    clientEventId: typeof input.clientEventId === 'string' ? input.clientEventId.trim().slice(0, 120) : '',
    clientCreatedAt: typeof input.clientCreatedAt === 'string' ? input.clientCreatedAt.trim().slice(0, 80) : ''
  };
}

async function readIndex(baizeRoot) {
  return readJsonIfExists(syncPaths(baizeRoot).indexFile, { lastVersion: 0, events: [] });
}

async function writeIndex(index, baizeRoot) {
  const storage = syncPaths(baizeRoot);
  await writeJson(storage.indexFile, index, storage.root);
}

async function appendSyncEvent(input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const normalized = normalizeClientEvent(input);
  const index = await readIndex(baizeRoot);
  const version = Number(index.lastVersion || 0) + 1;
  const event = {
    id: `sync-${crypto.randomUUID()}`,
    version,
    type: normalized.type,
    clientId: normalized.clientId,
    userId: normalized.userId,
    payload: normalized.payload,
    clientEventId: normalized.clientEventId,
    clientCreatedAt: normalized.clientCreatedAt,
    receivedAt: now.toISOString()
  };

  const storage = syncPaths(baizeRoot);
  await appendJsonLine(storage.eventsFile, event, storage.root);
  index.lastVersion = version;
  index.events = [event, ...(Array.isArray(index.events) ? index.events : [])].slice(0, 200);
  await writeIndex(index, baizeRoot);
  return event;
}

async function listSyncEvents({ since = 0, limit = 100 } = {}, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const safeSince = Math.max(0, Number(since) || 0);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const events = await readJsonLinesIfExists(syncPaths(baizeRoot).eventsFile);
  const filtered = events
    .filter((event) => Number(event.version) > safeSince)
    .sort((a, b) => Number(a.version) - Number(b.version))
    .slice(0, safeLimit);
  const index = await readIndex(baizeRoot);

  return {
    lastVersion: Number(index.lastVersion || 0),
    events: filtered
  };
}

module.exports = {
  appendSyncEvent,
  listSyncEvents
};
