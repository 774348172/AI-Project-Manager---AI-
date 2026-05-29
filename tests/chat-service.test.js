const fs = require('fs/promises');
const path = require('path');
const XLSX = require('xlsx');
const { handleChatMessage, handleChatMessageStream } = require('../src/services/baize-chat-service');
const { uploadAttachment } = require('../src/services/attachment-service');
const { getJiraOperation } = require('../src/services/jira-operation-service');
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

async function writeJiraConfig(baizeRoot) {
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
    'enabled: true',
    'baseURL: http://127.0.0.1:8080',
    'deploymentType: server',
    'apiVersion: "2"',
    'authType: bearer',
    'apiToken: test-token',
    'defaults:',
    '  projectKey: BZ',
    '  issueType: Task'
  ].join('\n'), 'utf8');
}

async function writeClaudeCodeConfig(baizeRoot) {
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');
}

async function jiraReadFetch(url) {
  if (url.includes('/rest/api/2/project/')) {
    const key = url.split('/').pop();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ key, name: `${key} 项目`, issueTypes: [{ id: '10002', name: '任务' }, { id: '10001', name: '需求' }] })
    };
  }
  if (url.includes('/rest/api/2/user/search')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([])
    };
  }
  return { ok: true, status: 200, text: async () => '{}' };
}

const ordinaryChatClassifier = async () => ({
  route: 'ordinary_chat',
  confidence: 0.95,
  reason: '普通聊天',
  requiresConfirmation: false
});

const operationClassifier = async () => ({
  route: 'operation',
  confidence: 0.95,
  reason: '交给 Claude Code 判断',
  requiresConfirmation: true
});

function inferJiraIntentRunner(input = {}) {
  const text = input.message && input.message.text ? input.message.text : '';
  if (text.includes('确认') && input.pendingJiraOperation && input.pendingJiraOperation.id) {
    return JSON.stringify({ kind: 'jira_confirm_operation', operationId: input.pendingJiraOperation.id });
  }
  if ((text.includes('负责人') || text.includes('任务负责人')) && input.pendingJiraOperation && input.pendingJiraOperation.id) {
    return JSON.stringify({ kind: 'jira_update_drafts', operationId: input.pendingJiraOperation.id, patch: { assignee: '曾浩然' } });
  }
  if (text.includes('项目的key') && input.pendingJiraOperation && input.pendingJiraOperation.id) {
    return JSON.stringify({ kind: 'jira_update_drafts', operationId: input.pendingJiraOperation.id, patch: { projectKey: 'BATTLE' } });
  }
  if (text.includes('查询曾浩然')) {
    return JSON.stringify({ kind: 'jira_search', query: { assignee: '曾浩然' } });
  }
  if (text.includes('写一条评论')) {
    return JSON.stringify({ kind: 'jira_add_comment', issueKey: 'BUG-1', body: '测试通过' });
  }
  if (text.includes('删除 BUG-1、BUG-2')) {
    return JSON.stringify({ kind: 'jira_delete_comment', targets: [{ issueKey: 'BUG-1' }, { issueKey: 'BUG-2' }], filterScope: 'self_ai_prefix' });
  }
  if (text.includes('删除 BUG-1')) {
    return JSON.stringify({ kind: 'jira_delete_comment', targets: [{ issueKey: 'BUG-1' }], filterScope: 'self_ai_prefix' });
  }
  const summary = text.includes('旧需求') ? '旧需求' : (text.includes('新需求') ? '新需求' : '测试');
  const projectKey = text.includes('BATTLE') ? 'BATTLE' : 'BZ';
  return JSON.stringify({
    kind: 'jira_bulk_create',
    drafts: [{ summary, description: text.includes('描述：测试') ? '测试' : '', projectKey, issueType: '任务', assignee: text.includes('曾浩然') ? '曾浩然' : undefined, labels: [] }]
  });
}

describe('baize chat service', () => {
  beforeEach(() => {
    clearClaudeEnv();
  });

  afterAll(() => {
    restoreOriginalEnv();
  });

  it('returns Baize reply with local knowledge results', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();

    const result = await handleChatMessage({
      text: '能量机制',
      userId: 'desktop-user',
      conversationId: 'desktop-conversation'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: ordinaryChatClassifier });

    expect(result).toMatchObject({
      provider: 'local_kb',
      message: {
        platform: 'desktop',
        userId: 'desktop-user',
        conversationId: 'desktop-conversation',
        text: '能量机制'
      }
    });
    expect(result.reply).toContain('白泽：');
    expect(result.reply).toContain('能量机制');
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'combat',
          relativePath: path.join('docs', 'combat.md')
        })
      ])
    );
    expect(result.results[0].path).toBeUndefined();
  });

  it('persists chat timing logs to runtime jsonl', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();

    const result = await handleChatMessage({
      text: '能量机制',
      conversationId: 'timing-log-conversation-1'
    }, { baizeRoot, claudeRouteClassifier: ordinaryChatClassifier });

    const logText = await fs.readFile(path.join(baizeRoot, 'runtime', 'chat-timing.jsonl'), 'utf8');
    const entries = logText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(result.provider).toBe('local_kb');
    expect(entries[0]).toMatchObject({
      conversationId: 'timing-log-conversation-1',
      provider: 'local_kb',
      status: 'ok'
    });
    expect(typeof entries[0].totalMs).toBe('number');
  });

  it('returns Baize reply when no local knowledge matches', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();

    const result = await handleChatMessage({ text: '不存在的关键词' }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: ordinaryChatClassifier });

    expect(result).toMatchObject({
      provider: 'local_kb',
      results: []
    });
    expect(result.reply).toContain('白泽：');
    expect(result.reply).toContain('暂时没有在本地知识库中找到相关内容');
  });

  it('returns Baize reply from an injected Claude provider', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    let providerInput;

    const result = await handleChatMessage({ text: '能量机制' }, {
      baizeRoot,
      provider: 'claude',
      claudeReplyGenerator: async (input) => {
        providerInput = input;
        return `白泽：Claude 已结合 ${input.knowledgeResults[0].title} 回答。`;
      }
    });

    expect(result).toMatchObject({
      provider: 'claude',
      reply: '白泽：Claude 已结合 combat 回答。',
      message: {
        platform: 'desktop',
        text: '能量机制'
      }
    });
    expect(providerInput.knowledgeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'combat' })
      ])
    );
  });

  it('passes Baize memory, logic, and skills context to Claude provider', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    let providerInput;
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.mkdir(path.join(baizeRoot, 'logic', 'rules'), { recursive: true });
    await fs.mkdir(path.join(baizeRoot, 'logic', 'executable'), { recursive: true });
    await fs.mkdir(path.join(baizeRoot, 'skills', 'wecom'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'memory', 'shallow', 'project.md'), '# project\n能量机制属于战斗系统。\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'logic', 'assertions', 'identity.md'), '# identity\n白泽应保持项目智能中枢身份。\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'logic', 'rules', 'intent-routing.md'), '# 意图路由\n优先识别用户目标。\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'logic', 'executable', 'routing-rules.yaml'), 'rules:\n  - name: route-chat\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'skills', 'registry.yaml'), 'skills:\n  - id: wecom\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'skills', 'wecom', 'skill.md'), '# 企业微信技能\n处理企业微信入口。', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'skills', 'wecom', 'config.yaml'), 'enabled: true\n', 'utf8');

    const result = await handleChatMessage({ text: '能量机制' }, {
      baizeRoot,
      claudeRouteClassifier: async () => ({ route: 'ordinary_chat', confidence: 0.95, reason: '普通聊天', requiresConfirmation: false }),
      claudeReplyGenerator: async (input) => {
        providerInput = input;
        return '白泽：Claude 已收到完整上下文。';
      }
    });

    expect(result.provider).toBe('claude');
    expect(providerInput.shallowMemoryResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'project', line: expect.stringContaining('能量机制属于战斗系统') })
    ]));
    expect(providerInput.logicContext.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'identity', content: expect.stringContaining('项目智能中枢身份') })
    ]));
    expect(providerInput.logicContext.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'intent-routing', content: expect.stringContaining('优先识别用户目标') })
    ]));
    expect(providerInput.logicContext.executableRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'routing-rules', content: expect.stringContaining('route-chat') })
    ]));
    expect(providerInput.skillsContext.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wecom', skillMarkdown: expect.stringContaining('企业微信技能') })
    ]));
  });

  it('passes prior messages to Claude when continuing a conversation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    let secondInput;

    await handleChatMessage({
      text: '我是 JUMP 群英集结的项目大管家',
      conversationId: 'long-conversation-1'
    }, {
      baizeRoot,
      provider: 'claude',
      claudeReplyGenerator: async () => '白泽：已记录。'
    });

    await handleChatMessage({
      text: '我刚才说我是谁？',
      conversationId: 'long-conversation-1'
    }, {
      baizeRoot,
      provider: 'claude',
      claudeReplyGenerator: async (input) => {
        secondInput = input;
        return '白泽：你是 JUMP 群英集结的项目大管家。';
      }
    });

    expect(secondInput.conversationMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', text: '我是 JUMP 群英集结的项目大管家' }),
      expect.objectContaining({ role: 'assistant', text: '白泽：已记录。' })
    ]));
  });

  it('uses Claude provider selected by server config', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), [
      'provider: claude',
      'claude:',
      '  apiKey: test-key',
      '  baseURL: https://claude.example.test',
      '  model: claude-opus-4-7'
    ].join('\n'), 'utf8');

    const result = await handleChatMessage({ text: '能量机制' }, {
      baizeRoot,
      claudeRouteClassifier: async () => ({ route: 'ordinary_chat', confidence: 0.95, reason: '普通聊天', requiresConfirmation: false }),
      claudeReplyGenerator: async () => '白泽：已使用配置文件中的 Claude。'
    });

    expect(result).toMatchObject({
      provider: 'claude',
      reply: '白泽：已使用配置文件中的 Claude。'
    });
  });

  it('rejects Claude provider when API key is missing', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await expect(handleChatMessage({ text: '能量机制' }, {
        baizeRoot,
        provider: 'claude'
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        publicMessage: '服务器尚未配置可用的大模型认证信息。'
      });
    } finally {
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
    }
  });

  it('streams Claude replies and persists the final assistant message', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    const events = [];

    const result = await handleChatMessageStream({
      text: '能量机制',
      conversationId: 'stream-conversation-1'
    }, {
      baizeRoot,
      provider: 'claude',
      claudeReplyGenerator: async ({ onDelta }) => {
        onDelta('白泽：');
        onDelta('流式回答。');
        return '白泽：流式回答。';
      },
      onEvent: (event) => events.push(event)
    });

    const saved = await handleChatMessage({
      text: '上一轮说了什么？',
      conversationId: 'stream-conversation-1'
    }, {
      baizeRoot,
      provider: 'claude',
      claudeReplyGenerator: async (input) => {
        expect(input.conversationMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', text: '白泽：流式回答。' })
        ]));
        return '白泽：上一轮已保存。';
      }
    });

    expect(events.map((event) => event.type).filter((type) => type !== 'activity')).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(result.reply).toBe('白泽：流式回答。');
    expect(saved.reply).toBe('白泽：上一轮已保存。');
  });

  it('uses Claude API classification before routing ordinary chat', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');
    let classifierInput;
    let replyInput;

    const result = await handleChatMessage({
      text: '能量机制',
      conversationId: 'classifier-chat-conversation-1'
    }, {
      baizeRoot,
      claudeRouteClassifier: async (input) => {
        classifierInput = input;
        return { route: 'ordinary_chat', confidence: 0.96, reason: '普通解释问题', requiresConfirmation: false };
      },
      claudeReplyGenerator: async (input) => {
        replyInput = input;
        return '白泽：这是普通聊天回复。';
      }
    });

    expect(classifierInput.message.text).toBe('能量机制');
    expect(classifierInput.knowledgeResults).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'combat' })]));
    expect(replyInput.message.text).toBe('能量机制');
    expect(result.provider).toBe('claude');
    expect(result.reply).toBe('白泽：这是普通聊天回复。');
  });

  it('uses Claude API classification to send Jira creation to Claude Code confirmation flow', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    let classifierCalled = false;

    const result = await handleChatMessage({
      text: '把这个需求整理成任务卡',
      conversationId: 'classifier-jira-create-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: async () => {
        classifierCalled = true;
        return { route: 'operation', confidence: 0.91, reason: '需要创建 Jira', requiresConfirmation: true };
      },
      claudeCodeRunner: async () => JSON.stringify({
        kind: 'jira_bulk_create',
        drafts: [{ summary: '分类器 Jira 任务', description: '由 Claude Code 草拟', projectKey: 'BZ', issueType: 'Task', labels: [] }]
      }),
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(classifierCalled).toBe(true);
    expect(result.provider).toBe('jira');
    expect(result.jiraOperation).toMatchObject({
      status: 'awaiting_confirmation',
      draftImport: { drafts: [expect.objectContaining({ summary: '分类器 Jira 任务' })] }
    });
  });

  it('falls back to Claude Code operation intent when Claude API classification fails', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    let runnerInput;

    const result = await handleChatMessage({
      text: '创建 jira 需求单\n标题：兜底需求\n描述：分类失败后仍应创建草稿',
      conversationId: 'classifier-fallback-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: async () => {
        throw new Error('classifier failed');
      },
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '兜底需求', description: '分类失败后仍应创建草稿', projectKey: 'BZ', issueType: 'Task', labels: [] }]
        });
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.permissionMode).toBe('operation_intent');
    expect(result.provider).toBe('jira');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({ summary: '兜底需求' });
  });

  it('keeps explicit Jira creation on the operation path even when classification says readonly', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const runnerInputs = [];

    const result = await handleChatMessage({
      text: '根据这个文本创建jira需求',
      conversationId: 'classifier-jira-explicit-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '显式 Jira 需求', description: '不要降级到普通 Claude Code 回复', projectKey: 'BZ', issueType: 'Task', labels: [] }]
        });
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInputs).toHaveLength(1);
    expect(runnerInputs[0].permissionMode).toBe('operation_intent');
    expect(result.provider).toBe('jira');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({ summary: '显式 Jira 需求' });
  });

  it('does not call Claude API classification for explicit providers', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    let classifierCalled = false;

    const result = await handleChatMessage({ text: '能量机制' }, {
      baizeRoot,
      provider: 'claude',
      claudeRouteClassifier: async () => {
        classifierCalled = true;
        return { route: 'jira_create', confidence: 1, reason: 'should not be used', requiresConfirmation: true };
      },
      claudeReplyGenerator: async () => '白泽：显式 provider 直接回复。'
    });

    expect(classifierCalled).toBe(false);
    expect(result.provider).toBe('claude');
  });

  it('routes readonly engineering requests to Claude Code operation intent when enabled', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    let runnerInput;
    await writeClaudeCodeConfig(baizeRoot);

    const result = await handleChatMessage({
      text: '请帮我看看聊天流式接口是怎么实现的',
      conversationId: 'code-conversation-1'
    }, {
      baizeRoot,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({ kind: 'engineering_reply', reply: '白泽：Claude Code 已完成只读分析。' });
      }
    });

    expect(result).toMatchObject({
      provider: 'claude_code',
      reply: '白泽：Claude Code 已完成只读分析。'
    });
    expect(runnerInput.permissionMode).toBe('operation_intent');
    expect(runnerInput.prompt).toContain('请帮我看看聊天流式接口是怎么实现的');
  });

  it('does not execute Claude Code operation intent when disabled', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    let called = false;

    const result = await handleChatMessage({ text: '请帮我看看聊天流式接口是怎么实现的' }, {
      baizeRoot,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async () => {
        called = true;
        return 'should not run';
      }
    });

    expect(result.provider).toBe('claude_code');
    expect(result.reply).toContain('服务器当前没有启用 Claude Code');
    expect(called).toBe(false);
  });

  it('streams Claude Code replies with compatible events', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    const events = [];
    await writeClaudeCodeConfig(baizeRoot);

    const result = await handleChatMessageStream({
      text: '分析一下服务端路由代码',
      conversationId: 'code-stream-conversation-1'
    }, {
      baizeRoot,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async () => JSON.stringify({ kind: 'engineering_reply', reply: '白泽：Claude Code 流式只读分析完成。' }),
      onEvent: (event) => events.push(event)
    });

    expect(events.map((event) => event.type).filter((type) => type !== 'activity')).toEqual(['meta', 'delta', 'done']);
    expect(events[0]).toMatchObject({ type: 'meta', provider: 'claude_code' });
    expect(result).toMatchObject({
      provider: 'claude_code',
      reply: '白泽：Claude Code 流式只读分析完成。'
    });
  });

  it('runs Claude Code operation intent for engineering write requests instead of local write gating', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    const events = [];
    let runnerInput;
    await writeClaudeCodeConfig(baizeRoot);

    const result = await handleChatMessageStream({ text: '帮我修复聊天接口 bug' }, {
      baizeRoot,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({ kind: 'engineering_reply', reply: '白泽：Claude Code 已判断这是工程请求。' });
      },
      onEvent: (event) => events.push(event)
    });

    expect(runnerInput.permissionMode).toBe('operation_intent');
    expect(result.provider).toBe('claude_code');
    expect(result.reply).toBe('白泽：Claude Code 已判断这是工程请求。');
    expect(result.pendingOperation).toBeNull();
    expect(events.map((event) => event.type).filter((type) => type !== 'activity')).toEqual(['meta', 'delta', 'done']);
  });

  it('routes Jira create requests through Claude Code draft confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);

    const result = await handleChatMessage({
      text: '创建 jira 需求单\n标题：测试需求\n描述：测试内容',
      conversationId: 'jira-create-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async () => JSON.stringify({
        kind: 'jira_bulk_create',
        drafts: [{ summary: '测试需求', description: '测试内容', projectKey: 'BZ', issueType: 'Task', labels: [] }]
      }),
      claudeReplyGenerator: async () => 'should not call claude'
    });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('已解析 1 个 Jira 需求单草稿');
    expect(result.jiraOperation).toMatchObject({
      status: 'awaiting_confirmation',
      conversationId: 'jira-create-conversation-1',
      draftImport: {
        count: 1,
        drafts: [expect.objectContaining({ summary: '测试需求', description: '测试内容', projectKey: 'BZ' })]
      }
    });
  });

  it('does not treat logic assertion instructions as pending Jira draft updates', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const runnerInputs = [];

    await handleChatMessage({
      text: '创建 jira 需求单\n标题：【赛季相关】赛季切换功能\n描述：测试内容',
      conversationId: 'logic-assertion-with-pending-jira-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '【赛季相关】赛季切换功能', description: '测试内容', projectKey: 'BZ', issueType: 'Task', labels: [] }]
        });
      }
    });

    const result = await handleChatMessage({
      text: '这里新加一条逻辑断言 处理人如果有多个 需要同时给多个人开单子 然后填上后面的预估时间 是一对一关系如果没有填预估时间则不填',
      conversationId: 'logic-assertion-with-pending-jira-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        return JSON.stringify({
          kind: 'logic_assertion',
          category: 'pm',
          statement: '处理人如果有多个，需要同时给多个人开单子；预估时间与处理人一对一对应，没有填预估时间则不填。'
        });
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(result.provider).toBe('local_kb');
    expect(result.reply).toContain('白泽：已新增逻辑断言。');
    expect(result.reply).toContain('处理人如果有多个');
    expect(result.reply).not.toContain('已更新 Jira 草稿');
    expect(runnerInputs).toHaveLength(2);
    expect(runnerInputs[1].pendingJiraOperation).toMatchObject({ status: 'awaiting_confirmation' });
  });

  it('uses Claude Code operation intent to create Jira confirmation cards when enabled', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const runnerInputs = [];
    let localParserCalled = false;

    const result = await handleChatMessage({
      text: '根据这个文档 创建对应的jira需求',
      conversationId: 'jira-claude-code-create-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      jiraDraftTextGenerator: async () => {
        localParserCalled = true;
        return 'should not parse locally';
      },
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        return JSON.stringify({
          kind: 'jira_bulk_create',
          reply: '已由 Claude Code 生成 Jira 草稿，请确认。',
          drafts: [{
            summary: '测试',
            description: '给曾浩然创建的测试需求',
            projectKey: 'BATTLE',
            issueType: '任务',
            assignee: '曾浩然',
            labels: ['claude-code']
          }]
        });
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(localParserCalled).toBe(false);
    expect(runnerInputs).toHaveLength(1);
    expect(runnerInputs[0].permissionMode).toBe('operation_intent');
    expect(runnerInputs[0].prompt).toContain('现在请判断用户请求属于哪种服务器操作意图');
    expect(result.provider).toBe('jira');
    expect(result.reply).toBe('已由 Claude Code 生成 Jira 草稿，请确认。');
    expect(result.jiraOperation).toMatchObject({
      status: 'awaiting_confirmation',
      draftImport: {
        drafts: [expect.objectContaining({
          summary: '测试',
          projectKey: 'BATTLE',
          issueType: '任务',
          assignee: '曾浩然',
          labels: ['claude-code']
        })]
      }
    });
  });

  it('runs Claude Code confirmed intent before typed Jira confirmation when enabled', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const runnerInputs = [];
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/rest/api/2/project/BATTLE')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ issueTypes: [{ id: '10002', name: '任务' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: '10010', key: 'BATTLE-1', self: 'http://jira/rest/api/2/issue/10010' })
      };
    };

    const created = await handleChatMessage({
      text: '给曾浩然创建一个jira单子，名字叫测试，项目key:BATTLE',
      conversationId: 'jira-claude-code-confirm-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '测试', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', labels: [] }]
        });
      }
    });

    const result = await handleChatMessage({
      text: '确认',
      conversationId: 'jira-claude-code-confirm-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        if (input.permissionMode === 'operation_intent') {
          return JSON.stringify({ kind: 'jira_confirm_operation', operationId: input.pendingJiraOperation.id });
        }
        return JSON.stringify({ kind: 'jira_confirmed_execute', operationId: input.operation.id, action: 'create' });
      }
    });

    expect(runnerInputs.map((input) => input.permissionMode)).toEqual(['operation_intent', 'operation_intent']);
    expect(runnerInputs[1].pendingJiraOperation.id).toBe(created.jiraOperation.id);
    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('BATTLE-1');
    expect(requests.map((request) => request.url)).toContain('http://127.0.0.1:8080/rest/api/2/issue');
  });

  it('emits Jira recovery event when typed confirmation hits a recoverable plugin error', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const runnerInputs = [];
    const events = [];
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith('/rest/api/2/project/BATTLE')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ issueTypes: [{ id: '10002', name: '任务' }] })
        };
      }
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          errorMessages: [],
          errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." }
        })
      };
    };

    await handleChatMessage({
      text: '给曾浩然创建一个jira单子，名字叫测试，项目key:BATTLE',
      conversationId: 'jira-recovery-stream-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '测试', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', labels: ['jump'] }]
        });
      }
    });

    const result = await handleChatMessageStream({
      text: '确认',
      conversationId: 'jira-recovery-stream-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInputs.push(input);
        if (input.permissionMode === 'operation_intent') {
          return JSON.stringify({ kind: 'jira_confirm_operation', operationId: input.pendingJiraOperation.id });
        }
        if (input.permissionMode === 'confirmed_operation_intent') {
          return JSON.stringify({ kind: 'jira_confirmed_execute', operationId: input.operation.id, action: 'create' });
        }
        return JSON.stringify({
          kind: 'plugin_operation_recovery',
          plugin: 'jira',
          operationId: input.operation.id,
          status: 'available',
          summary: '移除 labels 后重试。',
          reason: 'labels 不在创建界面。',
          actions: [{ id: 'retry_without_labels', label: '移除标签后重试创建', style: 'primary' }, { id: 'cancel', label: '取消创建' }]
        });
      },
      onEvent: (event) => events.push(event)
    });

    expect(runnerInputs.map((input) => input.permissionMode)).toEqual(['operation_intent', 'operation_intent']);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['jira_operation_recovery_required']));
    expect(result.jiraOperation).toMatchObject({
      status: 'recovery_required',
      recovery: { status: 'available', actions: expect.arrayContaining([expect.objectContaining({ id: 'retry_without_labels' })]) }
    });
  });

  it('uses server Claude to parse xlsx attachments with unclear columns', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 事项: 'JUMP 支持批量登录', 模块: '账号系统', 指派: '曾浩然' }
    ]), '收集表');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'jira-xlsx-claude-fallback-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });
    let runnerInput = null;

    const result = await handleChatMessage({
      text: '根据上传的 Excel 批量创建 jira 需求单',
      conversationId: 'jira-xlsx-claude-fallback-conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: [attachment.id]
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: 'JUMP 支持批量登录', description: '模块：账号系统', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', labels: [] }]
        });
      },
      jiraDraftTextGenerator: async () => {
        throw new Error('should not parse locally');
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.attachments[0]).toMatchObject({ fileName: 'JUMP需求收集表.xlsx' });
    expect(runnerInput.attachments[0].readPath).toContain('/JUMP需求收集表.xlsx');
    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('已解析 1 个 Jira 需求单草稿');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({
      summary: 'JUMP 支持批量登录',
      projectKey: 'BATTLE',
      issueType: '任务',
      assignee: '曾浩然'
    });
  });

  it('ignores flattened xlsx attachment summaries when asking Claude for Jira drafts', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 关卡模块: '通用关卡', 开发内容: '关卡相机表现流程控制', 策划验收状态: '', QA验收结果: '', jira链接: '', 优先级: '极高', 处理人: '曾浩然' }
    ]), '需求池');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'jira-xlsx-summary-pollution-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });
    let runnerInput = null;

    const result = await handleChatMessage({
      text: [
        '根据上传的 xlsx 创建 jira 任务',
        '',
        '以下是本次发送同时上传到服务器的附件分析结果，请结合这些附件回答：',
        '1. JUMP需求收集表.xlsx',
        '类型：spreadsheet',
        '分析摘要：收到表格文件 JUMP需求收集表.xlsx：工作表：【关卡】需求池 关卡模块,开发内容,策划验收状态,QA验收结果,jira链接,备注 通用关卡,关卡相机表现流程控制,,,,极高,'
      ].join('\n'),
      conversationId: 'jira-xlsx-summary-pollution-conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: [attachment.id]
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '关卡相机表现流程控制', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', priority: '极高', labels: [] }]
        });
      },
      jiraDraftTextGenerator: async () => {
        throw new Error('should not parse locally');
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.message.text).toContain('根据上传的 xlsx 创建 jira 任务');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({
      summary: '关卡相机表现流程控制',
      projectKey: 'BATTLE',
      issueType: '任务',
      assignee: '曾浩然',
      priority: '极高'
    });
    expect(result.jiraOperation.draftImport.drafts[0].status).toBeUndefined();
  });

  it('uses Claude Code with stored xlsx attachments for classified Jira create', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 关卡模块: '通用关卡', 开发内容: '关卡相机表现流程控制', 优先级: '极高', 处理人: '曾浩然' }
    ]), '需求池');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'jira-xlsx-classified-claude-code-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });
    let runnerInput = null;

    const result = await handleChatMessage({
      text: '根据文件增加jira单子',
      conversationId: 'jira-xlsx-classified-claude-code-conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: [attachment.id]
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: async (input) => {
        expect(input.attachments[0]).toMatchObject({ id: attachment.id, fileName: 'JUMP需求收集表.xlsx' });
        return { route: 'jira_create', confidence: 0.95, reason: '根据附件创建 Jira', requiresConfirmation: true };
      },
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '关卡相机表现流程控制', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', priority: '极高', labels: [] }]
        });
      },
      jiraDraftTextGenerator: async () => {
        throw new Error('should not parse locally');
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.permissionMode).toBe('operation_intent');
    expect(runnerInput.attachments[0]).toMatchObject({ id: attachment.id, fileName: 'JUMP需求收集表.xlsx' });
    expect(runnerInput.attachments[0].readPath).toContain('/JUMP需求收集表.xlsx');
    expect(runnerInput.attachments[0].semanticExtraction).toMatchObject({ kind: 'xlsx_semantic_text', source: 'server' });
    expect(runnerInput.prompt).toContain('服务器高保真表格抽取');
    expect(runnerInput.prompt).toContain('必须读取附件上下文里的原始可读取路径兜底');
    expect(runnerInput.prompt).toContain('不要只依据上传分析摘要生成草稿');
    expect(result.provider).toBe('jira');
    expect(result.jiraOperation.status).toBe('awaiting_confirmation');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({
      summary: '关卡相机表现流程控制',
      projectKey: 'BATTLE',
      issueType: '任务',
      assignee: '曾浩然',
      priority: '极高'
    });
  });

  it('routes non-ordinary other classification to Claude Code when enabled', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeClaudeCodeConfig(baizeRoot);
    let runnerInput = null;

    const result = await handleChatMessage({
      text: '整理一下这个本地工作事项并给我下一步建议',
      conversationId: 'classifier-other-claude-code-conversation-1'
    }, {
      baizeRoot,
      claudeRouteClassifier: async () => ({ route: 'other', confidence: 0.9, reason: '非普通聊天操作请求', requiresConfirmation: false }),
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({ kind: 'engineering_reply', reply: '白泽：Claude Code 已处理其它操作请求。' });
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.permissionMode).toBe('operation_intent');
    expect(result.provider).toBe('claude_code');
    expect(result.reply).toBe('白泽：Claude Code 已处理其它操作请求。');
  });

  it('uses Claude Code with latest conversation xlsx attachment without explicit attachment ids', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 标题: 'JUMP 战斗结算优化', 项目: 'BATTLE', 类型: '任务', 负责人: '曾浩然' }
    ]), '需求');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'jira-xlsx-claude-code-reuse-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });
    let runnerInput = null;

    const result = await handleChatMessage({
      text: '根据刚才上传的 xlsx 创建 jira 任务',
      conversationId: 'jira-xlsx-claude-code-reuse-conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: []
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: async () => ({ route: 'jira_create', confidence: 0.95, reason: '根据会话附件创建 Jira', requiresConfirmation: true }),
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: 'JUMP 战斗结算优化', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', labels: [] }]
        });
      },
      jiraDraftTextGenerator: async () => {
        throw new Error('should not parse locally');
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.attachments[0]).toMatchObject({ id: attachment.id, fileName: 'JUMP需求收集表.xlsx' });
    expect(runnerInput.attachments[0].readPath).toContain('/JUMP需求收集表.xlsx');
    expect(runnerInput.attachments[0].semanticExtraction).toMatchObject({ kind: 'xlsx_semantic_text', source: 'server' });
    expect(result.provider).toBe('jira');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({ summary: 'JUMP 战斗结算优化' });
  });

  it('reuses the latest conversation xlsx attachment for Jira drafts without reuploading', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 标题: 'JUMP 战斗结算优化', 项目: 'BATTLE', 类型: '任务', 负责人: '曾浩然' }
    ]), '需求');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'jira-xlsx-reuse-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });
    let runnerInput = null;

    const result = await handleChatMessage({
      text: '根据刚才上传的 xlsx 创建 jira 任务',
      conversationId: 'jira-xlsx-reuse-conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: []
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: 'JUMP 战斗结算优化', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', labels: [] }]
        });
      },
      jiraDraftTextGenerator: async () => {
        throw new Error('should not parse locally');
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.attachments[0]).toMatchObject({ fileName: 'JUMP需求收集表.xlsx' });
    expect(runnerInput.attachments[0].readPath).toContain('/JUMP需求收集表.xlsx');
    expect(result.provider).toBe('jira');
    expect(result.jiraOperation.draftImport.fileName).toBe('claude-code-jira-intent.json');
  });

  it('uses server Claude to parse xlsx attachments even when headers match directly', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 标题: 'JUMP 登录优化', 项目: 'BATTLE', 类型: '任务', 负责人: '曾浩然' }
    ]), '需求');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'jira-xlsx-chat-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });
    let runnerInput = null;

    const result = await handleChatMessage({
      text: '根据上传的 xlsx 创建 jira 任务',
      conversationId: 'jira-xlsx-chat-conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: [attachment.id]
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: 'JUMP 登录优化', projectKey: 'BATTLE', issueType: '任务', assignee: '曾浩然', labels: [] }]
        });
      },
      jiraDraftTextGenerator: async () => {
        throw new Error('should not parse locally');
      },
      claudeReplyGenerator: async () => 'should not call normal claude'
    });

    expect(runnerInput.attachments[0]).toMatchObject({ fileName: 'JUMP需求收集表.xlsx' });
    expect(runnerInput.attachments[0].readPath).toContain('/JUMP需求收集表.xlsx');
    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('已解析 1 个 Jira 需求单草稿');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({
      summary: 'JUMP 登录优化',
      projectKey: 'BATTLE',
      issueType: '任务',
      assignee: '曾浩然'
    });
  });

  it('routes natural Jira create requests with project key to draft confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);

    const result = await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE',
      conversationId: 'jira-natural-create-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.provider).toBe('jira');
    expect(result.jiraOperation.draftImport.warnings).toEqual([]);
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({
      summary: '测试',
      projectKey: 'BATTLE',
      issueType: '任务'
    });
  });

  it('updates latest pending Jira draft from typed assignee follow-up', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);

    await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE',
      conversationId: 'jira-draft-update-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    const result = await handleChatMessage({
      text: '负责人是曾浩然',
      conversationId: 'jira-draft-update-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('负责人：曾浩然');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({ assignee: '曾浩然' });
  });

  it('updates pending Jira draft project key without falling through to Claude', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);

    await handleChatMessage({
      text: '创建 jira 单子 标题：测试',
      conversationId: 'jira-project-update-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    const result = await handleChatMessage({
      text: '项目的key:BATTLE',
      conversationId: 'jira-project-update-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('项目 Key：BATTLE');
    expect(result.jiraOperation.draftImport.drafts[0]).toMatchObject({ projectKey: 'BATTLE' });
  });

  it('does not update or confirm Jira operations from another conversation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);

    await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE',
      conversationId: 'jira-owner-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    const result = await handleChatMessage({
      text: '负责人是曾浩然',
      conversationId: 'jira-owner-conversation-2',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      claudeRouteClassifier: ordinaryChatClassifier,
      claudeReplyGenerator: async () => '白泽：普通对话。'
    });

    expect(result.provider).not.toBe('jira');
    expect(result.jiraOperation).toBeNull();
  });

  it('supersedes old pending Jira draft when creating a new one in the same conversation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);

    const first = await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做旧需求 项目key:BATTLE',
      conversationId: 'jira-supersede-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });
    const second = await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做新需求 项目key:BATTLE',
      conversationId: 'jira-supersede-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    const oldOperation = await getJiraOperation(first.jiraOperation.id, { baizeRoot });
    expect(oldOperation.status).toBe('superseded');
    expect(second.jiraOperation.draftImport.drafts[0]).toMatchObject({ summary: '新需求' });
  });

  it('enriches Jira drafts with read-only Jira project and user data before confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.endsWith('/rest/api/2/project/BATTLE')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ key: 'BATTLE', name: '战斗管线', issueTypes: [{ id: '10002', name: '任务' }] })
        };
      }
      if (url.includes('/rest/api/2/user/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ name: 'zenghaoran', displayName: '曾浩然' }])
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };

    const created = await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE',
      conversationId: 'jira-readonly-enrich-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });
    const updated = await handleChatMessage({
      text: '任务负责人是曾浩然',
      conversationId: 'jira-readonly-enrich-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(created.jiraOperation.draftImport.drafts[0]).toMatchObject({ issueType: '任务', issueTypeId: '10002', projectName: '战斗管线' });
    expect(updated.jiraOperation.draftImport.drafts[0]).toMatchObject({ assignee: '曾浩然', assigneeName: 'zenghaoran' });
    expect(requests).toEqual(expect.arrayContaining([
      'http://127.0.0.1:8080/rest/api/2/project/BATTLE',
      'http://127.0.0.1:8080/rest/api/2/user/search?username=%E6%9B%BE%E6%B5%A9%E7%84%B6&maxResults=5'
    ]));
  });

  it('confirms latest pending Jira operation from typed confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/rest/api/2/project/BATTLE')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ issueTypes: [{ id: '10002', name: '任务' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: '10010', key: 'BATTLE-1', self: 'http://jira/rest/api/2/issue/10010' })
      };
    };

    await handleChatMessage({
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE',
      conversationId: 'jira-typed-confirm-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl: jiraReadFetch, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    const result = await handleChatMessage({
      text: '确认',
      conversationId: 'jira-typed-confirm-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('BATTLE-1');
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:8080/rest/api/2/issue'
    ]);
  });

  it('streams Jira create operation events for desktop confirmation cards', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const events = [];

    const result = await handleChatMessageStream({
      text: '批量创建 jira 单子\n描述：测试',
      conversationId: 'jira-create-stream-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl: jiraReadFetch,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: inferJiraIntentRunner,
      onEvent: (event) => events.push(event)
    });

    expect(result.provider).toBe('jira');
    expect(result.jiraOperation).toMatchObject({ status: 'awaiting_confirmation' });
    expect(events.map((event) => event.type).filter((type) => type !== 'activity')).toEqual(['meta', 'jira_operation_required', 'delta', 'done']);
    expect(events.find((event) => event.type === 'jira_operation_required').operation.draftImport.drafts[0]).toMatchObject({ summary: '测试', description: '测试' });
  });

  it('streams Jira search supplement events only after Claude Code requests user choice', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const events = [];
    const fetchImpl = async (url) => {
      if (url.includes('/rest/api/2/user/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([
            { name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true },
            { name: 'zenghaoran2', key: 'JIRAUSER20000', displayName: '曾浩然-策划', active: true }
          ])
        };
      }
      throw new Error('Jira issue search should wait for user selection');
    };

    const result = await handleChatMessageStream({
      text: '查询曾浩然的 Jira 需求单',
      conversationId: 'jira-search-supplement-stream-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeRouteClassifier: operationClassifier,
      claudeCodeRunner: async (input) => {
        if (input.permissionMode === 'operation_intent') {
          return JSON.stringify({ kind: 'jira_search', query: { assignee: '曾浩然' } });
        }
        return JSON.stringify({
          kind: 'jira_search_candidate_resolution',
          status: 'needs_user_input',
          reason: '两个候选都可能符合，需要用户确认。',
          choices: [
            { value: 'zenghaoran', label: '曾浩然-客户端' },
            { value: 'zenghaoran2', label: '曾浩然-策划' }
          ]
        });
      },
      onEvent: (event) => events.push(event)
    });

    expect(result.provider).toBe('jira');
    expect(result.jiraSearchSupplement).toMatchObject({ prompt: '两个候选都可能符合，需要用户确认。' });
    expect(events.map((event) => event.type).filter((type) => type !== 'activity')).toEqual(['meta', 'jira_search_supplement_required', 'delta', 'done']);
    expect(events.find((event) => event.type === 'jira_search_supplement_required').supplement.inputs[0]).toMatchObject({ id: 'jiraUser:曾浩然', type: 'select', options: ['zenghaoran', 'zenghaoran2'] });
  });

  it('routes single-comment writes through the audit gateway and executes only after confirm', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/rest/api/2/issue/BUG-1/comment')) {
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '10001' }) };
      }
      return jiraReadFetch(url, options);
    };
    const { confirmPluginAudit } = require('../src/services/baize-chat-service');

    const result = await handleChatMessage({
      text: '给 BUG-1 写一条评论：测试通过',
      conversationId: 'jira-comment-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('提交审计');
    expect(requests.find((item) => item.url.endsWith('/rest/api/2/issue/BUG-1/comment'))).toBeUndefined();

    const fs = require('fs/promises');
    const path = require('path');
    const files = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(files.length).toBeGreaterThan(0);
    const auditId = files[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    expect(confirmed.result.reply).toContain('BUG-1');
    expect(requests.some((item) => item.url.endsWith('/rest/api/2/issue/BUG-1/comment'))).toBe(true);
  });

  it('feeds Jira write failure back to Claude Code and stops after maxRecoveryAttempts', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: bearer',
      'username: jira-user',
      'apiToken: test-token'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');
    const dir = path.join(baizeRoot, 'runtime', 'jira-operations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
      operations: [{ status: 'created', createdIssues: [{ key: 'BATTLE-1' }] }]
    }), 'utf8');
    let putCount = 0;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/rest/api/2/issue/BATTLE-1') && options && options.method === 'PUT') {
        putCount += 1;
        return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: ['Jira 拒绝。'] }) };
      }
      return jiraReadFetch(url, options);
    };
    const runnerCalls = [];
    const claudeCodeRunner = async (input) => {
      runnerCalls.push(input.permissionMode);
      if (input.permissionMode === 'operation_intent') {
        return JSON.stringify({ kind: 'jira_update_issue', issueKey: 'BATTLE-1', fields: { priority: { name: '高' } } });
      }
      if (input.permissionMode === 'jira_write_error_analysis') {
        return JSON.stringify({
          kind: 'jira_write_recovery',
          plugin: 'jira',
          status: 'retry_available',
          summary: '可重试',
          action: { id: 'retry_with_unchanged_payload', label: '重试', requiresConfirmation: false }
        });
      }
      return '';
    };

    const result = await handleChatMessage({
      text: '把 BATTLE-1 改成高优先级',
      conversationId: 'jira-write-recovery-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });
    expect(result.reply).toContain('提交审计');

    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl, claudeCodeRunner });
    expect(confirmed.status).toBe('executed');
    expect(confirmed.result.failed).toBe(true);
    expect(putCount).toBe(3);
    expect(runnerCalls.filter((mode) => mode === 'jira_write_error_analysis').length).toBeGreaterThanOrEqual(1);
  });

  it('updates AI-created Jira issues through gateway with confirmation and Jira PUT', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: bearer',
      'username: jira-user',
      'apiToken: test-token'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');
    const dir = path.join(baizeRoot, 'runtime', 'jira-operations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
      operations: [{ status: 'created', createdIssues: [{ key: 'BATTLE-1' }] }]
    }), 'utf8');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      if (url.endsWith('/rest/api/2/issue/BATTLE-1') && options && options.method === 'PUT') {
        return { ok: true, status: 204, text: async () => '' };
      }
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_update_issue',
      issueKey: 'BATTLE-1',
      fields: { priority: { name: '高' } }
    });

    const result = await handleChatMessage({
      text: '把 BATTLE-1 的优先级改成高',
      conversationId: 'jira-update-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });
    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('提交审计');
    expect(calls.find((item) => item.method === 'PUT')).toBeUndefined();

    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(auditFiles.length).toBe(1);
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    const putCall = calls.find((item) => item.method === 'PUT' && item.url.endsWith('/rest/api/2/issue/BATTLE-1'));
    expect(putCall).toBeDefined();
  });

  it('denies update_issue against non-AI created issues', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: bearer',
      'username: jira-user',
      'apiToken: test-token'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_update_issue',
      issueKey: 'BUG-99',
      fields: { priority: { name: '高' } }
    });

    const result = await handleChatMessage({
      text: '把 BUG-99 的优先级改成高',
      conversationId: 'jira-update-deny-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });
    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('审计官拒绝');
    expect(calls.find((item) => item.method === 'PUT')).toBeUndefined();
  });

  it('routes jira_delete_comment through the audit officer and stops at require_confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: bearer',
      'username: jira-user',
      'apiToken: test-token'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');
    const dir = path.join(baizeRoot, 'runtime', 'jira-operations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
      operations: [
        { status: 'created', createdIssues: [{ key: 'BATTLE-1' }] }
      ]
    }), 'utf8');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_delete_comment',
      reply: '识别为删评论。',
      targets: [{ issueKey: 'BATTLE-1' }, { issueKey: 'BUG-9' }],
      filterScope: 'self_ai_prefix'
    });

    const events = [];
    await handleChatMessageStream({
      text: '帮我清理 BATTLE-1、BUG-9 的 AI 评论',
      conversationId: 'audit-confirm-conversation',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner,
      onEvent: (event) => events.push(event)
    });

    expect(calls.find((item) => item.method === 'DELETE')).toBeUndefined();
    const audit = events.find((event) => event.type === 'jira_audit_required');
    expect(audit).toBeDefined();
    expect(audit.decision).toBe('require_confirmation');
    expect(audit.perIssue.map((item) => ({ issueKey: item.issueKey, aiCreated: item.aiCreated, decision: item.decision }))).toEqual([
      { issueKey: 'BATTLE-1', aiCreated: true, decision: 'require_confirmation' },
      { issueKey: 'BUG-9', aiCreated: false, decision: 'require_confirmation' }
    ]);
    const reply = events.find((event) => event.type === 'delta');
    expect(reply.text).toContain('审计');
  });

  it('deletes only baize-authored AI-prefixed comments on the given Jira issues without confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: bearer',
      'username: jira-user',
      'apiToken: test-token',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Task'
    ].join('\n'), 'utf8');
    await writeClaudeCodeConfig(baizeRoot);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      const listMatch = url.match(/\/rest\/api\/2\/issue\/(BUG-\d+)\/comment\?/);
      if (listMatch) {
        const issueKey = listMatch[1];
        const comments = {
          'BUG-1': [
            { id: '101', body: '【AI 分析｜2026-05-23】BUG-1 分析草稿', author: { name: 'jira-user', key: 'JIRAUSER10000' } },
            { id: '102', body: '人类同事写的随手评论。', author: { name: 'someone-else', key: 'JIRAUSER20000' } },
            { id: '103', body: '【AI 分析】更早的 AI 草稿', author: { name: 'jira-user', key: 'JIRAUSER10000' } }
          ],
          'BUG-2': [
            { id: '201', body: '【AI 分析｜2026-05-22】BUG-2 分析', author: { name: 'jira-user', key: 'JIRAUSER10000' } },
            { id: '202', body: '【AI 分析｜2026-05-22】别人代写的 AI 草稿', author: { name: 'someone-else', key: 'JIRAUSER20000' } }
          ]
        }[issueKey] || [];
        return { ok: true, status: 200, text: async () => JSON.stringify({ comments }) };
      }
      const delMatch = url.match(/\/rest\/api\/2\/issue\/(BUG-\d+)\/comment\/(\d+)$/);
      if (delMatch && options && options.method === 'DELETE') {
        return { ok: true, status: 204, text: async () => '' };
      }
      return jiraReadFetch(url, options);
    };

    const result = await handleChatMessage({
      text: '帮我删除 BUG-1、BUG-2 的所有 AI 评论',
      conversationId: 'jira-delete-ai-comments-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('提交审计');
    expect(calls.filter((item) => item.method === 'DELETE')).toEqual([]);

    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(auditFiles.length).toBe(1);
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    const deletes = calls.filter((item) => item.method === 'DELETE');
    expect(deletes.map((item) => item.url)).toEqual([
      expect.stringContaining('/rest/api/2/issue/BUG-1/comment/101'),
      expect.stringContaining('/rest/api/2/issue/BUG-1/comment/103'),
      expect.stringContaining('/rest/api/2/issue/BUG-2/comment/201')
    ]);
    expect(confirmed.result.reply).toContain('扫描 2');
    expect(confirmed.result.reply).toContain('删除 3');
    expect(result.pendingOperation).toBeNull();
    expect(result.jiraOperation).toBeNull();
  });

  it('refuses to delete Jira comments when there is no Jira account identity configured', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: bearer',
      'apiToken: test-token'
    ].join('\n'), 'utf8');
    await writeClaudeCodeConfig(baizeRoot);
    const fetchImpl = async () => {
      throw new Error('Jira should not be called when identity is missing');
    };

    const result = await handleChatMessage({
      text: '帮我删除 BUG-1 的所有 AI 评论',
      conversationId: 'jira-delete-no-identity-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeRouteClassifier: operationClassifier, claudeCodeRunner: inferJiraIntentRunner });

    expect(result.reply).toContain('提交审计');

    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(auditFiles.length).toBe(1);
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    expect(confirmed.result.reply).toContain('不能安全删除');
  });

  it('bulk-writes Jira comments with per-issue bodies without confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const calls = [];
    const fetchImpl = async (url, options) => {
      const m = url.match(/\/rest\/api\/2\/issue\/(BUG-\d+)\/comment$/);
      if (m) {
        calls.push({ issueKey: m[1], body: JSON.parse(options.body).body });
        if (m[1] === 'BUG-6747') {
          return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: ['Jira 暂时拒绝。'] }) };
        }
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '40000' }) };
      }
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_bulk_add_comment',
      reply: '已挨个起草评论。',
      entries: [
        { issueKey: 'BUG-5983', body: '【AI 分析｜2026-05-23】BUG-5983 越界飞出根因分析。' },
        { issueKey: 'BUG-6798', body: '【AI 分析｜2026-05-23】BUG-6798 真机指示器缺失分析。' },
        { issueKey: 'BUG-6751', body: '【AI 分析｜2026-05-23】BUG-6751 自查建议。' },
        { issueKey: 'BUG-6747', body: '【AI 分析｜2026-05-23】BUG-6747 触发条件。' },
        { issueKey: 'BUG-6695', body: '【AI 分析｜2026-05-23】BUG-6695 回退方案。' }
      ]
    });

    const result = await handleChatMessage({
      text: '给 BUG-5983、BUG-6798、BUG-6751、BUG-6747、BUG-6695 各自写一段固定评论',
      conversationId: 'jira-bulk-comment-entries-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('提交审计');
    expect(calls).toEqual([]);
    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(auditFiles.length).toBe(1);
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    expect(calls.map((item) => item.issueKey)).toEqual(['BUG-5983', 'BUG-6798', 'BUG-6751', 'BUG-6747', 'BUG-6695']);
    expect(calls[0].body).toContain('BUG-5983');
    expect(calls[0].body).not.toContain('BUG-6798');
    expect(calls[1].body).toContain('BUG-6798');
    expect(calls[1].body).not.toContain('BUG-5983');
    expect(confirmed.result.reply).toContain('成功 4');
    expect(confirmed.result.reply).toContain('BUG-6747');
  });

  it('bulk-writes Jira comments across multiple issues without confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const calls = [];
    const fetchImpl = async (url, options) => {
      const m = url.match(/\/rest\/api\/2\/issue\/(BUG-\d+)\/comment$/);
      if (m) {
        calls.push({ issueKey: m[1], body: JSON.parse(options.body).body });
        if (m[1] === 'BUG-6747') {
          return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: ['Jira 暂时拒绝。'] }) };
        }
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '40000' }) };
      }
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_bulk_add_comment',
      reply: '已起草批量评论。',
      issueKeys: ['BUG-5983', 'BUG-6798', 'BUG-6751', 'BUG-6747', 'BUG-6695'],
      body: '【AI 分析｜2026-05-23】测试通过，等待发布。'
    });

    const result = await handleChatMessage({
      text: '给 BUG-5983、BUG-6798、BUG-6751、BUG-6747、BUG-6695 写一段统一的固定评论',
      conversationId: 'jira-bulk-comment-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('提交审计');
    expect(calls).toEqual([]);
    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(auditFiles.length).toBe(1);
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    expect(calls.map((item) => item.issueKey)).toEqual(['BUG-5983', 'BUG-6798', 'BUG-6751', 'BUG-6747', 'BUG-6695']);
    expect(calls.every((item) => item.body.includes('AI 分析'))).toBe(true);
    expect(confirmed.result.reply).toContain('成功 4');
    expect(confirmed.result.reply).toContain('BUG-6747');
  });

  it('routes Jira BUG AI analysis comments through engineering bug analysis first', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'workspacePath: D:\\zenghaorang\\Robot_BaiZe',
      'bugAnalysisWorkspacePath: D:\\zenghaorang\\WorkSpace'
    ].join('\n'), 'utf8');
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith('/rest/api/2/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            issues: [{
              key: 'BUG-5983',
              id: '5983',
              fields: {
                summary: '安迪 2 技能被墙体拦截',
                description: '墙消失后血路飞出。',
                status: { name: '未开始' },
                priority: { name: 'High' },
                labels: []
              }
            }]
          })
        };
      }
      if (url.includes('/rest/api/2/issue/BUG-5983?')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            key: 'BUG-5983',
            id: '5983',
            fields: {
              summary: '安迪 2 技能被墙体拦截',
              description: '墙消失后血路飞出。',
              status: { name: '未开始' },
              priority: { name: 'High' },
              labels: []
            }
          })
        };
      }
      const m = url.match(/\/rest\/api\/2\/issue\/(BUG-\d+)\/comment$/);
      if (m) {
        calls.push({ issueKey: m[1], body: JSON.parse(options.body).body });
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '50000' }) };
      }
      return jiraReadFetch(url, options);
    };
    const runnerInputs = [];
    const claudeCodeRunner = async (input) => {
      runnerInputs.push(input);
      if (input.permissionMode === 'bug_analysis_workspace') {
        return '已完成 SVN 更新；工程依据：Assets/Battle/Skills/AnDiSkill2.prefab，墙体消失后旧位移组件未终止。';
      }
      return JSON.stringify({
        kind: 'jira_bug_analysis',
        reply: '已准备进入 BUG 分析。',
        issueKeys: ['BUG-5983']
      });
    };

    const result = await handleChatMessage({
      text: '给 BUG-5983 写一段 AI 分析评论',
      conversationId: 'jira-bug-analysis-comment-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('工程级 BUG 分析后台任务');
    expect(result.bugAnalysisRun).toMatchObject({ status: 'running', total: 1 });
    expect(result.bugAnalysisRun.items[0]).toMatchObject({ issueKey: 'BUG-5983', status: 'pending' });
    const bugRunnerInput = runnerInputs.find((input) => input.permissionMode === 'bug_analysis_workspace');
    if (bugRunnerInput) {
      expect(bugRunnerInput.claudeCodeConfig.timeoutMs).toBeLessThanOrEqual(3600000);
    }
    await expect(fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toHaveLength(0);
  });

  it('routes contextual BUG analysis requests through Claude Code operation intent', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'workspacePath: D:\\zenghaorang\\Robot_BaiZe',
      'bugAnalysisWorkspacePath: D:\\zenghaorang\\WorkSpace'
    ].join('\n'), 'utf8');
    const issueKeys = ['BUG-6687', 'BUG-6798', 'BUG-6751', 'BUG-6747'];
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith('/rest/api/2/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            issues: issueKeys.map((key) => ({
              key,
              id: key.replace('BUG-', ''),
              fields: {
                summary: `${key} 待分析`,
                description: `${key} 描述`,
                status: { name: '未开始' },
                priority: { name: 'High' },
                labels: []
              }
            }))
          })
        };
      }
      return jiraReadFetch(url, options);
    };
    const runnerInputs = [];
    const claudeCodeRunner = async (input) => {
      runnerInputs.push(input);
      return JSON.stringify({
        kind: 'jira_bug_analysis',
        reply: '已准备进入 BUG 分析。',
        issueKeys
      });
    };

    const result = await handleChatMessage({
      text: '现在开始分析这四个BUG 然后自动AI写上评论',
      conversationId: 'jira-bug-analysis-contextual-routing-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner,
      claudeRouteClassifier: async () => ({ route: 'engineering_readonly', confidence: 0.95, reason: '只读分析', requiresConfirmation: false })
    });

    expect(runnerInputs[0].permissionMode).toBe('operation_intent');
    expect(result.provider).toBe('jira');
    expect(result.bugAnalysisRun).toMatchObject({ status: 'running', total: 4 });
    expect(result.bugAnalysisRun.items.map((item) => item.issueKey)).toEqual(issueKeys);
  });

  it('routes short BUG analysis continuation requests from conversation context', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'workspacePath: D:\\zenghaorang\\Robot_BaiZe',
      'bugAnalysisWorkspacePath: D:\\zenghaorang\\WorkSpace'
    ].join('\n'), 'utf8');
    const issueKeys = ['BUG-6687', 'BUG-6798'];
    const conversationId = 'jira-bug-analysis-short-context-conversation-1';
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith('/rest/api/2/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            issues: issueKeys.map((key) => ({
              key,
              id: key.replace('BUG-', ''),
              fields: {
                summary: `${key} 待分析`,
                description: `${key} 描述`,
                status: { name: '未开始' },
                priority: { name: 'High' },
                labels: []
              }
            }))
          })
        };
      }
      return jiraReadFetch(url, options);
    };
    await handleChatMessage({
      text: 'BUG-6687 BUG-6798 上下文记录',
      conversationId,
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeRouteClassifier: async () => ({ route: 'ordinary_chat', confidence: 0.95, reason: '测试上下文', requiresConfirmation: false })
    });
    const runnerInputs = [];
    const claudeCodeRunner = async (input) => {
      runnerInputs.push(input);
      return JSON.stringify({
        kind: 'jira_bug_analysis',
        reply: '已根据上下文准备进入 BUG 分析。',
        issueKeys
      });
    };

    const result = await handleChatMessage({
      text: '开始进行分析',
      conversationId,
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner,
      claudeRouteClassifier: async () => { throw new Error('classifier unavailable'); },
      claudeReplyGenerator: async () => { throw new Error('should not call normal Claude'); }
    });

    expect(runnerInputs[0].permissionMode).toBe('operation_intent');
    expect(result.provider).toBe('jira');
    expect(result.bugAnalysisRun).toMatchObject({ status: 'running', total: 2 });
    expect(result.bugAnalysisRun.items.map((item) => item.issueKey)).toEqual(issueKeys);
  });

  it('streams BUG analysis start events when Claude Code returns BUG analysis intent', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'workspacePath: D:\\zenghaorang\\Robot_BaiZe',
      'bugAnalysisWorkspacePath: D:\\zenghaorang\\WorkSpace'
    ].join('\n'), 'utf8');
    const events = [];
    const fetchImpl = async (url) => {
      if (url.endsWith('/rest/api/2/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            issues: [{
              key: 'BUG-5983',
              id: '5983',
              fields: {
                summary: '安迪 2 技能被墙体拦截',
                description: '墙消失后血路飞出。',
                status: { name: '未开始' },
                priority: { name: 'High' },
                labels: []
              }
            }]
          })
        };
      }
      return jiraReadFetch(url);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_bug_analysis',
      reply: '已准备进入 BUG 分析。',
      issueKeys: ['BUG-5983']
    });

    const result = await handleChatMessageStream({
      text: '给 BUG-5983 写一段 AI 分析评论',
      conversationId: 'jira-bug-analysis-stream-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner, onEvent: (event) => events.push(event) });

    expect(result.provider).toBe('jira');
    expect(result.bugAnalysisRun).toMatchObject({ status: 'running', total: 1 });
    expect(events.map((event) => event.type)).toContain('jira_bug_analysis_started');
    expect(events.find((event) => event.type === 'jira_bug_analysis_started')).toMatchObject({ issueKeys: ['BUG-5983'] });
  });

  it('does not start BUG analysis when Claude Code returns bulk comment intent', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const m = url.match(/\/rest\/api\/2\/issue\/(BUG-\d+)\/comment$/);
      if (m) {
        calls.push({ issueKey: m[1], body: JSON.parse(options.body).body });
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '50001' }) };
      }
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_bulk_add_comment',
      reply: '按固定文本写入评论。',
      entries: [{ issueKey: 'BUG-5983', body: 'AI 分析固定评论文本。' }]
    });

    const result = await handleChatMessage({
      text: '给 BUG-5983 写一段 AI 分析评论',
      conversationId: 'jira-bug-analysis-bulk-comment-decision-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(result.provider).toBe('jira');
    expect(result.bugAnalysisRun).toBeNull();
    expect(result.reply).toContain('提交审计');
    expect(calls).toHaveLength(0);
    const runStore = await fs.readFile(path.join(baizeRoot, 'runtime', 'bug-analysis', 'index.json'), 'utf8').catch(() => null);
    expect(runStore).toBeNull();
  });

  it('asks Claude Code to summarize and then writes the resulting Jira comment without confirmation', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/rest/api/2/issue/BUG-7/comment')) {
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '20001' }) };
      }
      return jiraReadFetch(url, options);
    };
    let runnerInput = null;
    const claudeCodeRunner = async (input) => {
      runnerInput = input;
      return JSON.stringify({
        kind: 'jira_summarize_then_comment',
        reply: '已根据最近调查总结进展。',
        issueKey: 'BUG-7',
        body: '【进展】关卡相机异常已定位，临时回滚至 v0.8，下版本前发补丁。',
        sources: [{ type: 'file', path: 'src/services/jira-search-service.js' }]
      });
    };

    const result = await handleChatMessage({
      text: '帮我总结一下 BUG-7 现在的进展，写到 Jira 评论里',
      conversationId: 'jira-summary-comment-conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(runnerInput.permissionMode).toBe('operation_intent');
    expect(runnerInput.prompt).toContain('jira_summarize_then_comment');
    expect(runnerInput.prompt).toContain('BUG-7');
    expect(result.provider).toBe('jira');
    expect(result.reply).toContain('提交审计');
    expect(requests.find((item) => item.url.endsWith('/rest/api/2/issue/BUG-7/comment'))).toBeUndefined();

    const { confirmPluginAudit } = require('../src/services/baize-chat-service');
    const auditFiles = await fs.readdir(path.join(baizeRoot, 'runtime', 'audit-pending'));
    expect(auditFiles.length).toBe(1);
    const auditId = auditFiles[0].replace(/\.json$/, '');
    const confirmed = await confirmPluginAudit(auditId, { baizeRoot }, { fetchImpl });
    expect(confirmed.status).toBe('executed');
    const commentRequest = requests.find((item) => item.url.endsWith('/rest/api/2/issue/BUG-7/comment'));
    expect(commentRequest).toBeDefined();
    expect(JSON.parse(commentRequest.options.body).body).toContain('关卡相机异常');
  });

  it('streams jira_comment_preview before writing the summarized Jira comment', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();
    await writeJiraConfig(baizeRoot);
    await writeClaudeCodeConfig(baizeRoot);
    const events = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/issue/BUG-9/comment')) {
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: '20002' }) };
      }
      return jiraReadFetch(url, options);
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_summarize_then_comment',
      reply: '已生成。',
      issueKey: 'BUG-9',
      body: '【进展】临时方案已上线。',
      sources: []
    });

    await handleChatMessageStream({
      text: '把对 BUG-9 的分析整理一段评论发到 Jira 上',
      conversationId: 'jira-summary-comment-stream-conversation-1',
      clientId: 'desktop-client-1'
    }, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner,
      onEvent: (event) => events.push(event)
    });

    const preview = events.find((event) => event.type === 'jira_comment_preview');
    expect(preview).toMatchObject({ issueKey: 'BUG-9', body: '【进展】临时方案已上线。' });
    const previewIndex = events.findIndex((event) => event.type === 'jira_comment_preview');
    const deltaIndex = events.findIndex((event) => event.type === 'delta');
    expect(previewIndex).toBeGreaterThan(-1);
    expect(deltaIndex).toBeGreaterThan(previewIndex);
  });

  it('rejects empty text', async () => {
    const { baizeRoot } = await seedKnowledgeBaseRoot();

    await expect(handleChatMessage({ text: '   ' }, { baizeRoot })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'text is required.'
    });
  });
});
