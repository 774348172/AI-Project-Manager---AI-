const { updateConversationMetadata } = require('./conversation-service');

function compactText(text, limit = 120) {
  const value = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function titleFromMessage(message) {
  const text = compactText(message && message.text, 28);
  return text || '新会话';
}

function collectTopics(messages) {
  const text = messages
    .map((message) => message.text || '')
    .join(' ');
  const candidates = ['项目', '记忆', '逻辑', '会话', '客户端', '服务器', '企业微信', 'Jira', '知识库', 'Claude'];
  return candidates.filter((candidate) => text.includes(candidate)).slice(0, 6);
}

async function observeConversationTurn({ conversation, userMessage, assistantMessage, historyMessages = [], baizeRoot } = {}) {
  if (!conversation) {
    return null;
  }

  const messages = [...historyMessages, userMessage, assistantMessage].filter(Boolean);
  const title = !conversation.title || conversation.title === '新会话'
    ? titleFromMessage(userMessage)
    : conversation.title;
  const manager = {
    summary: compactText(messages.slice(-6).map((message) => `${message.role}: ${message.text}`).join(' / '), 300),
    topics: collectTopics(messages),
    nextActions: []
  };

  return updateConversationMetadata(conversation.id, {
    title,
    manager,
    updatedAt: assistantMessage && assistantMessage.createdAt ? assistantMessage.createdAt : conversation.updatedAt
  }, { baizeRoot });
}

module.exports = {
  observeConversationTurn
};
