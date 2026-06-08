const { handleChatMessage } = require('./baize-chat-service');
const { getWeComConfig } = require('./config-service');
const { decryptCallbackPayload, parseXml } = require('./wecom-crypto-service');
const { assertConfigured, sendWeComTextMessage } = require('./wecom-client-service');

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
    userId: payload.from || payload.fromUser || payload.userId || payload.FromUserName || null,
    conversationId: payload.conversationId || payload.chatid || payload.FromUserName || null,
    text
  };
}

function normalizeCallbackPayload(payload) {
  return {
    msgtype: payload.MsgType,
    FromUserName: payload.FromUserName,
    ToUserName: payload.ToUserName,
    AgentID: payload.AgentID,
    text: {
      content: payload.Content
    }
  };
}

async function getConfiguredWeCom(options) {
  const config = options.config || await getWeComConfig(options);
  assertConfigured(config);
  return config;
}

async function handleWeComUrlVerification(query = {}, options = {}) {
  const config = await getConfiguredWeCom(options);
  return decryptCallbackPayload({
    token: config.token,
    encodingAESKey: config.encodingAESKey,
    corpId: config.corpId,
    signature: query.msg_signature,
    timestamp: query.timestamp,
    nonce: query.nonce,
    encrypted: query.echostr
  });
}

async function handleWeComCallback({ query = {}, body = '' } = {}, options = {}) {
  const config = await getConfiguredWeCom(options);
  const decryptedXml = decryptCallbackPayload({
    token: config.token,
    encodingAESKey: config.encodingAESKey,
    corpId: config.corpId,
    signature: query.msg_signature,
    timestamp: query.timestamp,
    nonce: query.nonce,
    encryptedXml: body
  });
  const message = parseXml(decryptedXml);
  const result = await handleWeComWebhook(normalizeCallbackPayload(message), options);

  if (result.handled && config.reply.enabled) {
    await sendWeComTextMessage({
      toUser: message.FromUserName,
      content: result.reply || '白泽：已收到。'
    }, { ...options, config });
  }

  return {
    handled: result.handled,
    reason: result.reason,
    message: result.message,
    provider: result.provider
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
  handleWeComWebhook,
  handleWeComUrlVerification,
  handleWeComCallback
};
