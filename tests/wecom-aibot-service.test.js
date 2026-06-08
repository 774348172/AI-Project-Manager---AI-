const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const { createWeComAiBotClient, connectAndAuthenticate, sendWeComAiBotMarkdown } = require('../src/services/wecom-aibot-service');

function createSdkMock() {
  const clients = [];
  class WSClient {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.sentMessages = [];
      this.replies = [];
      this.connected = false;
      clients.push(this);
    }

    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }

    off(event, handler) {
      if (this.handlers[event] === handler) {
        delete this.handlers[event];
      }
      return this;
    }

    connect() {
      this.connected = true;
      queueMicrotask(() => this.handlers.authenticated && this.handlers.authenticated());
      return this;
    }

    disconnect() {
      this.connected = false;
    }

    async replyStream(frame, streamId, content, finish) {
      this.replies.push({ frame, streamId, content, finish });
      return { errcode: 0 };
    }

    async sendMessage(chatId, body) {
      this.sentMessages.push({ chatId, body });
      return { errcode: 0 };
    }
  }

  return {
    WSClient,
    clients,
    generateReqId: () => 'stream-1'
  };
}

const config = {
  aiBot: {
    enabled: true,
    botId: 'bot-id',
    secret: 'bot-secret',
    wsUrl: 'wss://wecom.example.test/ws',
    notifyChatId: 'chat-default',
    reply: { enabled: true }
  }
};

describe('WeCom AI bot service', () => {
  it('creates SDK client with Bot ID, Secret and WebSocket URL', async () => {
    const sdk = createSdkMock();

    const { client } = await createWeComAiBotClient({ config, sdk });

    expect(client.options).toMatchObject({
      botId: 'bot-id',
      secret: 'bot-secret',
      wsUrl: 'wss://wecom.example.test/ws'
    });
  });

  it('handles text messages through existing WeCom webhook flow and replies through stream', async () => {
    const sdk = createSdkMock();
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'docs', 'combat.md'), '# 战斗系统\n\n能量机制说明。', 'utf8');
    const { client } = await createWeComAiBotClient({
      baizeRoot,
      config,
      sdk,
      claudeRouteClassifier: async () => ({ route: 'ordinary_chat', confidence: 0.9, reason: '普通聊天', requiresConfirmation: false })
    });

    await client.handlers['message.text']({
      headers: { req_id: 'req-1' },
      body: {
        from: 'user-1',
        chatid: 'chat-1',
        text: { content: '白泽 能量机制' }
      }
    });

    expect(client.replies).toHaveLength(1);
    expect(client.replies[0]).toMatchObject({
      streamId: 'stream-1',
      finish: true
    });
    expect(client.replies[0].content).toContain('白泽：');
  });

  it('waits for authentication before connecting a send client', async () => {
    const sdk = createSdkMock();
    const { client } = await createWeComAiBotClient({ config, sdk });

    await connectAndAuthenticate(client);

    expect(client.connected).toBe(true);
  });

  it('actively sends markdown messages to configured notify chat', async () => {
    const client = {
      sentMessages: [],
      sendMessage: async function sendMessage(chatId, body) {
        this.sentMessages.push({ chatId, body });
      }
    };

    await sendWeComAiBotMarkdown({ content: '构建失败' }, { config, client });

    expect(client.sentMessages).toEqual([
      {
        chatId: 'chat-default',
        body: { msgtype: 'markdown', markdown: { content: '构建失败' } }
      }
    ]);
  });

  it('rejects notification without chat id', async () => {
    await expect(sendWeComAiBotMarkdown({ content: '构建失败' }, {
      config: {
        aiBot: {
          ...config.aiBot,
          notifyChatId: null
        }
      },
      client: { sendMessage: vi.fn() }
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: '企业微信智能机器人通知缺少 chatId。'
    });
  });
});
