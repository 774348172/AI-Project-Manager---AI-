const fs = require('fs/promises');
const path = require('path');
const { handleWeComWebhook } = require('../src/services/wecom-service');
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

describe('wecom service', () => {
  let baizeRoot;

  beforeEach(async () => {
    clearClaudeEnv();
    ({ baizeRoot } = await seedKnowledgeBaseRoot());
  });

  afterAll(() => {
    restoreOriginalEnv();
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
