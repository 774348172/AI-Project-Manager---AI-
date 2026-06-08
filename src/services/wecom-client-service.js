const { getWeComConfig } = require('./config-service');

const WECOM_API_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';
const tokenCache = new Map();

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function integrationError(message) {
  const error = new Error(message);
  error.code = 'WECOM_INTEGRATION_ERROR';
  error.statusCode = 502;
  error.publicMessage = message;
  return error;
}

function assertConfigured(config) {
  if (!config.enabled) {
    throw validationError('企业微信插件未启用。');
  }
  for (const key of ['corpId', 'agentId', 'secret', 'token', 'encodingAESKey']) {
    if (!config[key]) {
      throw validationError(`企业微信配置缺少 ${key}。`);
    }
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text.trim() === '' ? {} : JSON.parse(text);
  } catch (error) {
    throw integrationError('企业微信接口返回了无效 JSON。');
  }
}

async function getAccessToken(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const cacheKey = `${config.corpId}:${config.secret}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now() + 60000) {
    return cached.token;
  }

  const url = new URL(`${WECOM_API_BASE_URL}/gettoken`);
  url.searchParams.set('corpid', config.corpId);
  url.searchParams.set('corpsecret', config.secret);
  const response = await fetchImpl(url.toString());
  const payload = await readJsonResponse(response);
  if (!response.ok || payload.errcode !== 0 || !payload.access_token) {
    throw integrationError(`获取企业微信 access_token 失败：${payload.errmsg || response.status}`);
  }

  tokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: now() + Math.max(Number(payload.expires_in) || 7200, 60) * 1000
  });
  return payload.access_token;
}

async function sendWeComTextMessage({ toUser, content }, options = {}) {
  const config = options.config || await getWeComConfig(options);
  assertConfigured(config);
  if (!toUser) {
    throw validationError('企业微信回复缺少接收人。');
  }
  const token = await getAccessToken(config, options);
  const url = new URL(`${WECOM_API_BASE_URL}/message/send`);
  url.searchParams.set('access_token', token);
  const response = await (options.fetchImpl || fetch)(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: toUser,
      msgtype: 'text',
      agentid: Number(config.agentId),
      text: { content },
      safe: 0
    })
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || payload.errcode !== 0) {
    throw integrationError(`发送企业微信消息失败：${payload.errmsg || response.status}`);
  }
  return payload;
}

function clearWeComTokenCache() {
  tokenCache.clear();
}

module.exports = {
  assertConfigured,
  getAccessToken,
  sendWeComTextMessage,
  clearWeComTokenCache
};
