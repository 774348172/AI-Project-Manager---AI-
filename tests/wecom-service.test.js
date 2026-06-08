const fs = require('fs/promises');
const path = require('path');
const { handleWeComWebhook, handleWeComUrlVerification, handleWeComCallback } = require('../src/services/wecom-service');
const { buildSignature, encryptMessage } = require('../src/services/wecom-crypto-service');
const { clearWeComTokenCache } = require('../src/services/wecom-client-service');
const { getWeComConfig, getPublicWeComConfig } = require('../src/services/config-service');
const { createTestRoot } = require('./helpers/test-root');

const originalEnv = {
  BAIZE_CHAT_PROVIDER: process.env.BAIZE_CHAT_PROVIDER,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  BAIZE_CLAUDE_BASE_URL: process.env.BAIZE_CLAUDE_BASE_URL
};

function clearClaudeEnv() {
  delete process.env.BAIZE_CHAT_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.BAIZE_CLAUDE_BASE_URL;
}

function restoreOriginalEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

clearClaudeEnv();

async function seedKnowledgeBaseRoot() {
  const { baizeRoot } = await createTestRoot();
  const docsDir = path.join(baizeRoot, 'docs');
  const skillDir = path.join(baizeRoot, 'skills', 'knowledge-base');

  await fs.mkdir(docsDir, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, 'combat.md'), '# 战斗系统\n\n角色技能冷却和能量机制。', 'utf8');
  await fs.writeFile(path.join(skillDir, 'skill.md'), '# 知识库插件\n\n支持检索项目知识库。', 'utf8');

  return { baizeRoot };
}

const ordinaryChatClassifier = async () => ({
  route: 'ordinary_chat',
  confidence: 0.95,
  reason: '普通聊天',
  requiresConfirmation: false
});

const wecomConfig = {
  enabled: true,
  corpId: 'wwtestcorp',
  agentId: '1000002',
  secret: 'wecom-secret',
  token: 'wecom-token',
  encodingAESKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  reply: { enabled: true }
};

async function writeWeComConfig(baizeRoot, overrides = {}) {
  const config = {
    ...wecomConfig,
    ...overrides,
    reply: {
      ...wecomConfig.reply,
      ...(overrides.reply || {})
    }
  };
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(baizeRoot, 'config', 'wecom.yaml'), [
    `enabled: ${config.enabled}`,
    `corpId: "${config.corpId}"`,
    `agentId: "${config.agentId}"`,
    `secret: "${config.secret}"`,
    `token: "${config.token}"`,
    `encodingAESKey: "${config.encodingAESKey}"`,
    'reply:',
    `  enabled: ${config.reply.enabled}`
  ].join('\n'), 'utf8');
  return config;
}

function encryptCallbackXml(xml, config = wecomConfig, timestamp = '1710000000', nonce = 'nonce-1') {
  const encrypted = encryptMessage(xml, config.encodingAESKey, config.corpId, () => Buffer.alloc(16, 1));
  const signature = buildSignature(config.token, timestamp, nonce, encrypted);
  return {
    query: { msg_signature: signature, timestamp, nonce },
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    encrypted
  };
}

describe('wecom service', () => {
  let baizeRoot;

  beforeEach(async () => {
    clearClaudeEnv();
    clearWeComTokenCache();
    ({ baizeRoot } = await seedKnowledgeBaseRoot());
  });

  afterAll(() => {
    restoreOriginalEnv();
  });

  it('reads WeCom config without leaking secrets in public config', async () => {
    await writeWeComConfig(baizeRoot);

    await expect(getWeComConfig({ baizeRoot })).resolves.toMatchObject(wecomConfig);
    await expect(getPublicWeComConfig({ baizeRoot })).resolves.toEqual({
      enabled: true,
      corpIdConfigured: true,
      agentIdConfigured: true,
      secretConfigured: true,
      tokenConfigured: true,
      encodingAESKeyConfigured: true,
      reply: { enabled: true },
      aiBot: {
        enabled: false,
        botConfigured: false,
        wsUrlConfigured: false,
        notifyChatConfigured: false,
        reply: { enabled: true }
      }
    });
  });

  it('decrypts WeCom URL verification echo string', async () => {
    await writeWeComConfig(baizeRoot);
    const encrypted = encryptMessage('verify-success', wecomConfig.encodingAESKey, wecomConfig.corpId, () => Buffer.alloc(16, 1));
    const query = {
      msg_signature: buildSignature(wecomConfig.token, '1710000000', 'nonce-1', encrypted),
      timestamp: '1710000000',
      nonce: 'nonce-1',
      echostr: encrypted
    };

    await expect(handleWeComUrlVerification(query, { baizeRoot })).resolves.toBe('verify-success');
  });

  it('handles encrypted WeCom text callback and sends an active reply', async () => {
    await writeWeComConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/gettoken')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, access_token: 'access-token-1', expires_in: 7200 }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, errmsg: 'ok' }) };
    };
    const callback = encryptCallbackXml([
      '<xml>',
      '<ToUserName><![CDATA[wwtestcorp]]></ToUserName>',
      '<FromUserName><![CDATA[user-1]]></FromUserName>',
      '<CreateTime>1710000000</CreateTime>',
      '<MsgType><![CDATA[text]]></MsgType>',
      '<Content><![CDATA[白泽 能量机制]]></Content>',
      '<MsgId>1</MsgId>',
      '<AgentID>1000002</AgentID>',
      '</xml>'
    ].join(''));

    const result = await handleWeComCallback(callback, { baizeRoot, fetchImpl, claudeRouteClassifier: ordinaryChatClassifier });

    expect(result).toMatchObject({ handled: true, provider: 'local_kb' });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain('/gettoken');
    expect(requests[1].url).toContain('/message/send');
    expect(JSON.parse(requests[1].options.body)).toMatchObject({
      touser: 'user-1',
      msgtype: 'text',
      agentid: 1000002,
      text: { content: expect.stringContaining('白泽：') }
    });
  });

  it('ignores encrypted WeCom callback without wake words and does not reply', async () => {
    await writeWeComConfig(baizeRoot);
    const fetchImpl = vi.fn();
    const callback = encryptCallbackXml([
      '<xml>',
      '<ToUserName><![CDATA[wwtestcorp]]></ToUserName>',
      '<FromUserName><![CDATA[user-2]]></FromUserName>',
      '<CreateTime>1710000000</CreateTime>',
      '<MsgType><![CDATA[text]]></MsgType>',
      '<Content><![CDATA[能量机制]]></Content>',
      '<MsgId>2</MsgId>',
      '<AgentID>1000002</AgentID>',
      '</xml>'
    ].join(''));

    await expect(handleWeComCallback(callback, { baizeRoot, fetchImpl })).resolves.toEqual({
      handled: false,
      reason: 'not_mentioned',
      message: undefined,
      provider: undefined
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles Baize wake word and returns a local knowledge reply', async () => {
    const result = await handleWeComWebhook({
      msgtype: 'text',
      from: 'user-1',
      chatid: 'chat-1',
      text: {
        content: '白泽 能量机制'
      }
    }, { baizeRoot, claudeRouteClassifier: ordinaryChatClassifier });

    expect(result).toMatchObject({
      handled: true,
      provider: 'local_kb',
      message: {
        platform: 'wecom',
        userId: 'user-1',
        conversationId: 'chat-1',
        text: '能量机制'
      }
    });
    expect(result.reply).toContain('白泽：');
    expect(result.reply).toContain('能量机制');
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'combat' })
      ])
    );
  });

  it('handles Xiaoze wake word', async () => {
    const result = await handleWeComWebhook({
      msgtype: 'text',
      userId: 'user-2',
      conversationId: 'conversation-2',
      text: {
        content: '@小泽 战斗系统'
      }
    }, { baizeRoot });

    expect(result).toMatchObject({
      handled: true,
      message: {
        platform: 'wecom',
        userId: 'user-2',
        conversationId: 'conversation-2',
        text: '战斗系统'
      }
    });
  });

  it('ignores text messages without wake words', async () => {
    const result = await handleWeComWebhook({
      msgtype: 'text',
      text: {
        content: '能量机制'
      }
    }, { baizeRoot });

    expect(result).toEqual({
      handled: false,
      reason: 'not_mentioned'
    });
  });

  it('rejects non-text messages', async () => {
    await expect(handleWeComWebhook({
      msgtype: 'image',
      image: { media_id: 'media-1' }
    }, { baizeRoot })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'msgtype must be text.'
    });
  });

  it('rejects empty text content', async () => {
    await expect(handleWeComWebhook({
      msgtype: 'text',
      text: { content: '   ' }
    }, { baizeRoot })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'text.content is required.'
    });
  });
});
