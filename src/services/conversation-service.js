const crypto = require('crypto');
const path = require('path');
const paths = require('../config/paths');
const {
  readJsonIfExists,
  writeJson,
  appendJsonLine,
  readJsonLinesIfExists
} = require('../lib/file-store');

const DEFAULT_TITLE = '新会话';
const MAX_ID_LENGTH = 120;

function validationError(message, code = 'VALIDATION_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function getConversationPaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'conversations');
  return {
    root,
    indexFile: path.join(root, 'index.json'),
    messagesDir: path.join(root, 'messages')
  };
}

function generateId(prefix = 'conv') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function assertSafeId(value, label = 'conversationId') {
  const id = normalizeString(value);
  if (!id) {
    return null;
  }

  if (id.length > MAX_ID_LENGTH || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw validationError(`${label} is invalid.`);
  }

  return id;
}

function previewText(text) {
  const value = normalizeString(text) || '';
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function normalizeConversation(input = {}, now = new Date()) {
  const timestamp = nowIso(now);
  const id = assertSafeId(input.id || input.conversationId, 'conversationId') || generateId();

  return {
    id,
    title: normalizeString(input.title) || DEFAULT_TITLE,
    platform: normalizeString(input.platform) || 'desktop',
    userId: normalizeString(input.userId),
    clientId: normalizeString(input.clientId),
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp,
    turnCount: Number.isInteger(input.turnCount) ? input.turnCount : 0,
    lastMessagePreview: normalizeString(input.lastMessagePreview) || '',
    status: normalizeString(input.status) || 'active',
    manager: input.manager && typeof input.manager === 'object' ? input.manager : {
      summary: '',
      topics: [],
      nextActions: []
    }
  };
}

function normalizeMessage(input = {}, conversation, now = new Date()) {
  const role = normalizeString(input.role);
  if (!['user', 'assistant', 'system'].includes(role)) {
    throw validationError('message role is invalid.');
  }

  const text = normalizeString(input.text);
  if (!text) {
    throw validationError('message text is required.');
  }

  return {
    id: assertSafeId(input.id, 'messageId') || generateId('msg'),
    conversationId: conversation.id,
    role,
    text,
    platform: normalizeString(input.platform) || conversation.platform,
    userId: normalizeString(input.userId) || conversation.userId,
    clientId: normalizeString(input.clientId) || conversation.clientId,
    provider: normalizeString(input.provider),
    results: Array.isArray(input.results) ? input.results : [],
    createdAt: input.createdAt || nowIso(now)
  };
}

async function readIndex({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const conversationPaths = getConversationPaths(baizeRoot);
  const index = await readJsonIfExists(conversationPaths.indexFile, { conversations: [] });
  return {
    conversations: Array.isArray(index.conversations) ? index.conversations : []
  };
}

async function writeIndex(index, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const conversationPaths = getConversationPaths(baizeRoot);
  await writeJson(conversationPaths.indexFile, index, conversationPaths.root);
}

function sortConversations(conversations) {
  return conversations.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function upsertConversation(conversation, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const index = await readIndex({ baizeRoot });
  const existing = index.conversations.filter((item) => item.id !== conversation.id);
  const conversations = sortConversations([conversation, ...existing]);
  await writeIndex({ conversations }, { baizeRoot });
  return conversation;
}

async function createConversation(input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const conversation = normalizeConversation(input, now);
  await upsertConversation(conversation, { baizeRoot });
  return conversation;
}

async function ensureConversation(input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const id = assertSafeId(input.id || input.conversationId, 'conversationId');
  if (id) {
    const existing = await getConversationMetadata(id, { baizeRoot });
    if (existing) {
      return existing;
    }
  }

  return createConversation({ ...input, id }, { baizeRoot, now });
}

async function getConversationMetadata(conversationId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const id = assertSafeId(conversationId, 'conversationId');
  const index = await readIndex({ baizeRoot });
  return index.conversations.find((conversation) => conversation.id === id) || null;
}

async function listConversations({ platform, userId, clientId, status, limit = 100 } = {}, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const index = await readIndex({ baizeRoot });
  const filters = {
    platform: normalizeString(platform),
    userId: normalizeString(userId),
    clientId: normalizeString(clientId),
    status: normalizeString(status)
  };
  const max = Math.max(1, Math.min(Number(limit) || 100, 500));

  return sortConversations(index.conversations)
    .filter((conversation) => !filters.platform || conversation.platform === filters.platform)
    .filter((conversation) => !filters.userId || conversation.userId === filters.userId)
    .filter((conversation) => !filters.clientId || conversation.clientId === filters.clientId)
    .filter((conversation) => !filters.status || conversation.status === filters.status)
    .slice(0, max);
}

async function getConversationMessages(conversationId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const id = assertSafeId(conversationId, 'conversationId');
  const conversationPaths = getConversationPaths(baizeRoot);
  return readJsonLinesIfExists(path.join(conversationPaths.messagesDir, `${id}.jsonl`));
}

async function getConversation(conversationId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const conversation = await getConversationMetadata(conversationId, { baizeRoot });
  if (!conversation) {
    const error = new Error('Conversation not found.');
    error.code = 'NOT_FOUND';
    error.statusCode = 404;
    error.publicMessage = 'Conversation not found.';
    throw error;
  }

  return {
    conversation,
    messages: await getConversationMessages(conversation.id, { baizeRoot })
  };
}

async function appendConversationMessage(conversationId, messageInput, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const conversation = await ensureConversation({ conversationId }, { baizeRoot, now });
  const message = normalizeMessage(messageInput, conversation, now);
  const conversationPaths = getConversationPaths(baizeRoot);
  await appendJsonLine(path.join(conversationPaths.messagesDir, `${conversation.id}.jsonl`), message, conversationPaths.root);

  const updatedConversation = {
    ...conversation,
    updatedAt: message.createdAt,
    turnCount: conversation.turnCount + 1,
    lastMessagePreview: previewText(message.text)
  };
  await upsertConversation(updatedConversation, { baizeRoot });

  return {
    conversation: updatedConversation,
    message
  };
}

async function updateConversationMetadata(conversationId, patch = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const conversation = await getConversationMetadata(conversationId, { baizeRoot });
  if (!conversation) {
    return createConversation({ ...patch, id: conversationId }, { baizeRoot, now });
  }

  const updated = {
    ...conversation,
    title: normalizeString(patch.title) || conversation.title,
    status: normalizeString(patch.status) || conversation.status,
    manager: patch.manager && typeof patch.manager === 'object' ? patch.manager : conversation.manager,
    updatedAt: patch.updatedAt || conversation.updatedAt
  };
  await upsertConversation(updated, { baizeRoot });
  return updated;
}

module.exports = {
  DEFAULT_TITLE,
  assertSafeId,
  createConversation,
  ensureConversation,
  getConversation,
  getConversationMetadata,
  getConversationMessages,
  listConversations,
  appendConversationMessage,
  updateConversationMetadata
};
