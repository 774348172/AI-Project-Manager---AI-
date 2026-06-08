const { getWeComConfig } = require('./config-service');
const { handleWeComWebhook } = require('./wecom-service');

let runtimeClient = null;
let runtimeStarted = false;

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function integrationError(message) {
  const error = new Error(message);
  error.code = 'WECOM_AI_BOT_INTEGRATION_ERROR';
  error.statusCode = 502;
  error.publicMessage = message;
  return error;
}

function assertAiBotConfigured(config) {
  if (!config.aiBot.enabled) {
    throw validationError('企业微信智能机器人未启用。');
  }
  if (!config.aiBot.botId) {
    throw validationError('企业微信智能机器人配置缺少 botId。');
  }
  if (!config.aiBot.secret) {
    throw validationError('企业微信智能机器人配置缺少 secret。');
  }
}

function buildClientOptions(config, options = {}) {
  const clientOptions = {
    botId: config.aiBot.botId,
    secret: config.aiBot.secret
  };
  if (config.aiBot.wsUrl) {
    clientOptions.wsUrl = config.aiBot.wsUrl;
  }
  if (options.logger) {
    clientOptions.logger = options.logger;
  }
  return clientOptions;
}

function getAiBotSdk(options = {}) {
  return options.sdk || require('@wecom/aibot-node-sdk');
}

async function getConfiguredAiBot(options = {}) {
  const config = options.config && options.config.aiBot ? options.config : await getWeComConfig(options);
  assertAiBotConfigured(config);
  return config;
}

async function createWeComAiBotClient(options = {}) {
  const config = await getConfiguredAiBot(options);
  const sdk = getAiBotSdk(options);
  const WSClient = sdk.WSClient || (sdk.default && sdk.default.WSClient);
  if (typeof WSClient !== 'function') {
    throw integrationError('企业微信智能机器人 SDK 不可用。');
  }

  const client = new WSClient(buildClientOptions(config, options));
  client.on('message.text', async (frame) => {
    if (!config.aiBot.reply.enabled) {
      return;
    }
    try {
      const result = await handleWeComWebhook({
        msgtype: 'text',
        from: frame.body && (frame.body.from || frame.body.from_userid || frame.body.userid),
        chatid: frame.body && (frame.body.chatid || frame.body.chat_id || frame.body.conversation_id),
        text: {
          content: frame.body && frame.body.text && frame.body.text.content
        }
      }, options);
      if (result.handled) {
        const streamId = sdk.generateReqId ? sdk.generateReqId('baize') : `baize_${Date.now()}`;
        await client.replyStream(frame, streamId, result.reply || '白泽：已收到。', true);
      }
    } catch (error) {
      console.error('[wecom-aibot] message handling failed:', error && error.message ? error.message : error);
    }
  });
  client.on('error', (error) => {
    console.error('[wecom-aibot] connection error:', error && error.message ? error.message : error);
  });
  return { client, config };
}

function waitForAuthenticated(client, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(integrationError('企业微信智能机器人长连接认证超时。'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      client.off?.('authenticated', onAuthenticated);
      client.off?.('error', onError);
      client.off?.('disconnected', onDisconnected);
    };
    const onAuthenticated = () => {
      cleanup();
      resolve(client);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDisconnected = () => {
      cleanup();
      reject(integrationError('企业微信智能机器人长连接已断开。'));
    };

    client.on('authenticated', onAuthenticated);
    client.on('error', onError);
    client.on('disconnected', onDisconnected);
  });
}

async function connectAndAuthenticate(client, options = {}) {
  const authenticated = waitForAuthenticated(client, options.authTimeoutMs);
  client.connect();
  await authenticated;
  return client;
}

async function startWeComAiBot(options = {}) {
  const { client } = await createWeComAiBotClient(options);
  await connectAndAuthenticate(client, options);
  runtimeClient = client;
  runtimeStarted = true;
  return client;
}

function stopWeComAiBot() {
  if (runtimeClient && typeof runtimeClient.disconnect === 'function') {
    runtimeClient.disconnect();
  }
  runtimeClient = null;
  runtimeStarted = false;
}

async function getSendClient(options = {}) {
  if (options.client) {
    return { client: options.client, shouldDisconnect: false };
  }
  if (runtimeClient) {
    return { client: runtimeClient, shouldDisconnect: false };
  }
  const { client } = await createWeComAiBotClient(options);
  await connectAndAuthenticate(client, options);
  return { client, shouldDisconnect: true };
}

async function sendWeComAiBotMarkdown({ chatId, content }, options = {}) {
  const config = await getConfiguredAiBot(options);
  const targetChatId = chatId || config.aiBot.notifyChatId;
  if (!targetChatId) {
    throw validationError('企业微信智能机器人通知缺少 chatId。');
  }
  const { client, shouldDisconnect } = await getSendClient({ ...options, config });
  try {
    await client.sendMessage(targetChatId, {
      msgtype: 'markdown',
      markdown: { content }
    });
  } finally {
    if (shouldDisconnect && typeof client.disconnect === 'function') {
      client.disconnect();
    }
  }
  return { errcode: 0, errmsg: 'ok' };
}

function getWeComAiBotRuntimeState() {
  return {
    started: runtimeStarted
  };
}

module.exports = {
  assertAiBotConfigured,
  createWeComAiBotClient,
  connectAndAuthenticate,
  startWeComAiBot,
  stopWeComAiBot,
  sendWeComAiBotMarkdown,
  getWeComAiBotRuntimeState
};
