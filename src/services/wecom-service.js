const { handleChatMessage } = require('./baize-chat-service');

const WAKE_WORDS = ['@白泽', '@小泽', '白泽', '小泽'];

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw validationError('payload must be an object.');
  }
}

function extractText(payload) {
  if (payload.msgtype !== 'text') {
    throw validationError('msgtype must be text.');
  }

  const content = payload.text && payload.text.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw validationError('text.content is required.');
  }

  return content.trim();
}

function removeWakeWords(text) {
  let normalized = text;

  for (const wakeWord of WAKE_WORDS) {
    normalized = normalized.replaceAll(wakeWord, ' ');
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

function isMentioned(text) {
  return WAKE_WORDS.some((wakeWord) => text.includes(wakeWord));
}

function normalizeMessage(payload, text) {
  return {
    platform: 'wecom',
    userId: payload.from || payload.fromUser || payload.userId || null,
    conversationId: payload.conversationId || payload.chatid || null,
    text
  };
}

async function handleWeComWebhook(payload, options = {}) {
  const { baizeRoot, ...chatOptions } = options;
  requireObject(payload);
  const originalText = extractText(payload);

  if (!isMentioned(originalText)) {
    return {
      handled: false,
      reason: 'not_mentioned'
    };
  }

  const text = removeWakeWords(originalText);
  if (text === '') {
    throw validationError('message text is required after wake word.');
  }

  const chatResult = await handleChatMessage(normalizeMessage(payload, text), { baizeRoot, ...chatOptions });

  return {
    handled: true,
    ...chatResult
  };
}

module.exports = {
  handleWeComWebhook
};
