const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_TITLE = '新会话';

function safeId(value, label = 'id') {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const id = value.trim();
  if (id.length > 120 || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    const error = new Error(`${label} is invalid.`);
    error.code = 'INVALID_ID';
    throw error;
  }

  return id;
}

function generateId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function compactText(text, limit = 80) {
  const value = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function getStorePaths(userDataPath) {
  const root = path.join(userDataPath, 'conversations');
  return {
    root,
    indexFile: path.join(root, 'index.json'),
    messagesDir: path.join(root, 'messages')
  };
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim() === '' ? fallback : JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    return [];
  }
}

function sortConversations(conversations) {
  return conversations.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function createConversationStore(userDataPath) {
  const storePaths = getStorePaths(userDataPath);

  async function readIndex() {
    const index = await readJson(storePaths.indexFile, { conversations: [] });
    return {
      conversations: Array.isArray(index.conversations) ? index.conversations : []
    };
  }

  async function writeIndex(index) {
    await writeJson(storePaths.indexFile, {
      conversations: sortConversations(index.conversations).slice(0, 200)
    });
  }

  async function upsertConversation(conversation) {
    const index = await readIndex();
    const conversations = [
      conversation,
      ...index.conversations.filter((item) => item.id !== conversation.id)
    ];
    await writeIndex({ conversations });
    return conversation;
  }

  async function listConversations() {
    const index = await readIndex();
    return sortConversations(index.conversations);
  }

  async function createConversation(input = {}) {
    const createdAt = new Date().toISOString();
    const conversation = {
      id: safeId(input.id, 'conversationId') || generateId('desktop'),
      title: compactText(input.title, 36) || DEFAULT_TITLE,
      createdAt,
      updatedAt: createdAt,
      lastMessagePreview: '',
      turnCount: 0
    };
    return upsertConversation(conversation);
  }

  async function updateConversation(id, patch = {}) {
    const conversationId = safeId(id, 'conversationId');
    const index = await readIndex();
    const current = index.conversations.find((item) => item.id === conversationId) || await createConversation({ id: conversationId });
    const updated = {
      ...current,
      title: compactText(patch.title, 36) || current.title,
      lastMessagePreview: patch.lastMessagePreview !== undefined ? compactText(patch.lastMessagePreview) : current.lastMessagePreview,
      turnCount: Number.isInteger(patch.turnCount) ? patch.turnCount : current.turnCount,
      updatedAt: patch.updatedAt || new Date().toISOString()
    };
    return upsertConversation(updated);
  }

  async function appendMessage(conversationId, input = {}) {
    const id = safeId(conversationId, 'conversationId');
    let conversation = (await readIndex()).conversations.find((item) => item.id === id);
    if (!conversation) {
      conversation = await createConversation({ id });
    }

    const message = {
      id: safeId(input.id, 'messageId') || generateId('msg'),
      conversationId: id,
      role: input.role === 'assistant' ? 'assistant' : 'user',
      text: typeof input.text === 'string' ? input.text : '',
      meta: typeof input.meta === 'string' ? input.meta : '',
      results: Array.isArray(input.results) ? input.results : [],
      claudeCodeOperation: input.claudeCodeOperation && typeof input.claudeCodeOperation === 'object' ? input.claudeCodeOperation : null,
      jiraOperation: input.jiraOperation && typeof input.jiraOperation === 'object' ? input.jiraOperation : null,
      jiraSearchSupplement: input.jiraSearchSupplement && typeof input.jiraSearchSupplement === 'object' ? input.jiraSearchSupplement : null,
      jiraAudit: input.jiraAudit && typeof input.jiraAudit === 'object' ? input.jiraAudit : null,
      bugAnalysisRun: input.bugAnalysisRun && typeof input.bugAnalysisRun === 'object' ? input.bugAnalysisRun : null,
      attachment: input.attachment && typeof input.attachment === 'object' ? input.attachment : null,
      createdAt: input.createdAt || new Date().toISOString()
    };
    await appendJsonLine(path.join(storePaths.messagesDir, `${id}.jsonl`), message);
    const messages = await readJsonLines(path.join(storePaths.messagesDir, `${id}.jsonl`));
    const updated = await updateConversation(id, {
      title: conversation.title === DEFAULT_TITLE && message.role === 'user' ? message.text : conversation.title,
      lastMessagePreview: message.text,
      turnCount: messages.length,
      updatedAt: message.createdAt
    });
    return { conversation: updated, message };
  }

  async function getConversation(id) {
    const conversationId = safeId(id, 'conversationId');
    const index = await readIndex();
    const conversation = index.conversations.find((item) => item.id === conversationId);
    return {
      conversation: conversation || null,
      messages: await readJsonLines(path.join(storePaths.messagesDir, `${conversationId}.jsonl`))
    };
  }

  async function deleteConversation(id) {
    const conversationId = safeId(id, 'conversationId');
    const index = await readIndex();
    const conversations = index.conversations.filter((item) => item.id !== conversationId);
    await writeIndex({ conversations });
    try {
      await fs.unlink(path.join(storePaths.messagesDir, `${conversationId}.jsonl`));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    return { deleted: conversations.length !== index.conversations.length };
  }

  return {
    listConversations,
    createConversation,
    updateConversation,
    appendMessage,
    getConversation,
    deleteConversation
  };
}

module.exports = {
  createConversationStore,
  safeId
};
