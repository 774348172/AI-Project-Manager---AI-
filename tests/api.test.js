const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const testRoot = fsSync.mkdtempSync(path.join(projectRoot, '.test-baize-'));
const baizeRoot = path.join(testRoot, 'baize');
const originalEnv = {
  BAIZE_CHAT_PROVIDER: process.env.BAIZE_CHAT_PROVIDER,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  BAIZE_CLAUDE_BASE_URL: process.env.BAIZE_CLAUDE_BASE_URL
};
process.env.BAIZE_ROOT = baizeRoot;

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

const request = require('supertest');
const { createApp } = require('../src/app');
const { createPendingOperation } = require('../src/services/pending-operation-service');
const { createJiraCreateOperation } = require('../src/services/jira-operation-service');

const memoryCategories = ['programming', 'design', 'art', 'general', 'pm', 'project'];
const logicCategories = ['programming', 'design', 'art', 'general', 'pm', 'project', 'identity'];

async function seedApiRoot() {
  await fs.rm(path.join(baizeRoot, 'runtime', 'sync-events'), { recursive: true, force: true });
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'shallow'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'indexes'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'logic', 'assertions'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'docs'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'skills', 'knowledge-base'), { recursive: true });

  await fs.writeFile(path.join(baizeRoot, 'config', 'global.md'), '# 白泽全局设定\n', 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'config', 'global.yaml'), 'system:\n  name: "白泽"\n', 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: local_kb\nclaude:\n  apiKey: ""\n  baseURL: ""\n  model: claude-opus-4-7\n', 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: false\n', 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'config', 'client-runtime.yaml'), [
    'enabled: true',
    'localClaudeCode:',
    '  enabled: true',
    '  managedByServer: true',
    '  minVersion: "0.2.1"',
    'sync:',
    '  enabled: true',
    '  pollIntervalMs: 15000'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'config', 'plugin-updates.yaml'), [
    'enabled: true',
    'plugins:',
    '  - id: jira',
    '    name: Jira',
    '    enabled: true',
    '    version: "1.0.0"',
    '    required: true',
    '    permissions:',
    '      allowLocalDecision: true',
    '      allowedActions:',
    '        - create_issue',
    '        - search_issue',
    '      deniedActions:',
    '        - delete_issue',
    '      requiresUserConfirmation: true'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'docs', 'combat.md'), '# 战斗系统\n\n角色技能冷却和能量机制。\n', 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'skills', 'knowledge-base', 'skill.md'), '# 知识库插件\n\n支持检索项目知识库。\n', 'utf8');

  await Promise.all([
    ...memoryCategories.flatMap((category) => [
      fs.writeFile(path.join(baizeRoot, 'memory', 'shallow', `${category}.md`), `# ${category}\n`, 'utf8'),
      fs.writeFile(
        path.join(baizeRoot, 'memory', 'deep', 'indexes', `${category}-index.md`),
        '# Index\n\n| 标题 | 路径 | 标签 | 摘要 | 更新时间 |\n|---|---|---|---|---|\n',
        'utf8'
      )
    ]),
    ...logicCategories.map((category) =>
      fs.writeFile(path.join(baizeRoot, 'logic', 'assertions', `${category}.md`), `# ${category}\n`, 'utf8')
    )
  ]);
}

describe('baize local hub API', () => {
  beforeEach(async () => {
    clearClaudeEnv();
    await seedApiRoot();
  });

  afterAll(() => {
    restoreOriginalEnv();
  });
  it('returns health status', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: 'baize-local-hub',
      phase: '1'
    });
  });

  it('returns global config markdown and parsed yaml', async () => {
    const app = createApp();

    const response = await request(app).get('/config/global');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.markdown).toContain('白泽全局设定');
    expect(response.body.data.config.system.name).toBe('白泽');
  });

  it('returns empty global config when config files are missing', async () => {
    const app = createApp();
    await fs.rm(path.join(baizeRoot, 'config', 'global.md'));
    await fs.rm(path.join(baizeRoot, 'config', 'global.yaml'));

    const response = await request(app).get('/config/global');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      markdown: '',
      config: {}
    });
  });

  it('returns public Claude Code config', async () => {
    const app = createApp();
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'routing:',
      '  autoDetectEngineeringTasks: true',
      'permissions:',
      '  defaultMode: read_only',
      '  requireConfirmation: true',
      'security:',
      '  denySecretFiles: true',
      '  secretPaths:',
      '    - .env',
      'env:',
      '  ANTHROPIC_AUTH_TOKEN: server-token',
      '  ANTHROPIC_BASE_URL: http://claude.example.test'
    ].join('\n'), 'utf8');

    const response = await request(app).get('/config/claude-code');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      enabled: true,
      workspaceConfigured: false,
      bugAnalysisWorkspaceConfigured: false,
      routing: { autoDetectEngineeringTasks: true },
      permissions: {
        defaultMode: 'read_only',
        requireConfirmation: true
      }
    });
    expect(JSON.stringify(response.body)).not.toContain('.env');
    expect(JSON.stringify(response.body)).not.toContain('server-token');
    expect(JSON.stringify(response.body)).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(JSON.stringify(response.body)).not.toContain('ANTHROPIC_BASE_URL');
  });

  it('returns client runtime control-plane status', async () => {
    const app = createApp();
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'workspacePath: D:/server/workspace',
      'settingsPath: D:/server/.claude/settings.json',
      'svn:',
      '  password: svn-secret',
      'env:',
      '  ANTHROPIC_AUTH_TOKEN: server-token',
      '  ANTHROPIC_BASE_URL: http://claude.example.test',
      '  EMPTY_VALUE: ""'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://jira.example.test',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: basic',
      'username: jira-user',
      'password: jira-secret',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: 需求',
      'fields:',
      '  taskOwner: customfield_10010'
    ].join('\n'), 'utf8');

    const response = await request(app)
      .get('/client/runtime')
      .query({ clientId: 'desktop-client-1', platform: 'windows' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      enabled: true,
      clientId: 'desktop-client-1',
      platform: 'windows',
      localClaudeCode: {
        enabled: true,
        managedByServer: true,
        minVersion: '0.2.1',
        command: 'claude',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'server-token',
          ANTHROPIC_BASE_URL: 'http://claude.example.test'
        }
      },
      jira: {
        enabled: true,
        baseURL: 'http://jira.example.test',
        deploymentType: 'server',
        apiVersion: '2',
        authType: 'basic',
        username: 'jira-user',
        password: 'jira-secret',
        defaultProjectKey: 'BZ',
        defaultIssueType: '需求',
        fieldMappings: { taskOwner: 'customfield_10010' }
      },
      sync: {
        enabled: true,
        pollIntervalMs: 15000
      }
    });
    expect(JSON.stringify(response.body)).not.toContain('apiKey');
    expect(JSON.stringify(response.body)).not.toContain('svn-secret');
    expect(JSON.stringify(response.body)).not.toContain('D:/server/workspace');
    expect(JSON.stringify(response.body)).not.toContain('settings.json');
    expect(JSON.stringify(response.body)).not.toContain('EMPTY_VALUE');
  });

  it('returns plugin update control-plane status', async () => {
    const app = createApp();

    const response = await request(app).get('/plugins/updates');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      enabled: true,
      plugins: [
        {
          id: 'jira',
          name: 'Jira',
          enabled: true,
          version: '1.0.0',
          updateUrl: null,
          sha256: null,
          required: true,
          permissions: {
            allowLocalDecision: true,
            allowedActions: ['create_issue', 'search_issue'],
            deniedActions: ['delete_issue'],
            requiresUserConfirmation: true
          },
          updatedAt: null
        }
      ]
    });
  });

  it('returns client forced update status without leaking file paths', async () => {
    const app = createApp();
    await fs.writeFile(path.join(baizeRoot, 'config', 'client-version.yaml'), [
      'enabled: true',
      'currentVersion: "0.2.0"',
      'minimumVersion: "0.2.0"',
      'forceUpdate: true',
      'releaseNotes: "必须更新。"',
      'windows:',
      '  updateDir: "D:/secret/update-dir"'
    ].join('\n'), 'utf8');

    const response = await request(app).get('/client/version?platform=windows&version=0.1.0');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      enabled: true,
      currentVersion: '0.2.0',
      clientVersion: '0.1.0',
      updateAvailable: true,
      updateRequired: true,
      forceUpdate: true
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('returns public Claude config without leaking API key', async () => {
    const app = createApp();
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalBaizeBaseUrl = process.env.BAIZE_CLAUDE_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.BAIZE_CLAUDE_BASE_URL;
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), [
      'provider: claude',
      'claude:',
      '  apiKey: secret-test-key',
      '  baseURL: https://claude.example.test',
      '  model: claude-opus-4-7'
    ].join('\n'), 'utf8');

    try {
      const response = await request(app).get('/config/claude');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        provider: 'claude',
        enabled: null,
        apiKeyConfigured: true,
        baseURL: 'https://claude.example.test',
        model: 'claude-opus-4-7'
      });
      expect(JSON.stringify(response.body)).not.toContain('secret-test-key');
    } finally {
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
      if (originalBaseUrl) {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      }
      if (originalBaizeBaseUrl) {
        process.env.BAIZE_CLAUDE_BASE_URL = originalBaizeBaseUrl;
      }
    }
  });

  it('hides internal errors from API responses', async () => {
    const app = createApp();
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.yaml'), 'system: [', 'utf8');

    const response = await request(app).get('/config/global');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.'
      }
    });
  });

  it('writes shallow memory through the API', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/shallow')
      .send({
        category: 'general',
        content: 'API 写入测试。',
        source: 'manual'
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.category).toBe('general');
    expect(response.body.data.file).toContain('general.md');
  });

  it('finds shallow memory through the API', async () => {
    const app = createApp();

    await request(app)
      .post('/memory/shallow')
      .send({
        category: 'general',
        content: 'API 查询测试。',
        source: 'manual'
      })
      .expect(200);

    const response = await request(app)
      .get('/memory/shallow')
      .query({ category: 'general', q: 'API 查询' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'general',
          line: expect.stringContaining('API 查询测试')
        })
      ])
    );
  });

  it('returns empty shallow memory results when a category file is missing', async () => {
    const app = createApp();
    await fs.rm(path.join(baizeRoot, 'memory', 'shallow', 'general.md'));

    const response = await request(app)
      .get('/memory/shallow')
      .query({ category: 'general', q: 'missing' });

    expect(response.status).toBe(200);
    expect(response.body.data.results).toEqual([]);
  });

  it('registers a deep memory index through the API', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/deep/index')
      .send({
        category: 'project',
        title: 'API 深层索引测试',
        path: path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project', 'api-test.md'),
        tags: ['API', '测试'],
        summary: '通过 API 登记深层记忆索引。'
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.category).toBe('project');
    expect(response.body.data.pathExists).toBe(false);
  });

  it('rejects deep memory index paths outside baize root through the API', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/deep/index')
      .send({
        category: 'project',
        title: 'API 外部路径测试',
        path: 'G:/Robot/outside-project-memory.md',
        tags: ['API', '测试'],
        summary: '拒绝探测白泽根目录外的路径。'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'path must be inside baize root.'
      }
    });
  });

  it('drafts a passive logic assertion through the API', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/logic/assertions/draft')
      .send({
        category: 'design',
        statement: 'API 被动逻辑草案测试。',
        source: 'passive_detected'
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.requiresConfirmation).toBe(true);
    expect(response.body.data.file).toContain('drafts.md');
  });

  it('appends and lists sync events through the API', async () => {
    const app = createApp();

    const appendResponse = await request(app)
      .post('/sync/events')
      .send({
        type: 'logic_assertion.created',
        clientId: 'desktop-client-api',
        userId: 'desktop-user',
        clientEventId: 'client-event-1',
        clientCreatedAt: '2026-05-26T10:00:00.000Z',
        payload: {
          category: 'pm',
          statement: '多人负责人需要一对一拆分 Jira 单。'
        }
      });

    expect(appendResponse.status).toBe(200);
    expect(appendResponse.body.ok).toBe(true);
    expect(appendResponse.body.data.event).toMatchObject({
      version: 1,
      type: 'logic_assertion.created',
      clientId: 'desktop-client-api',
      userId: 'desktop-user',
      clientEventId: 'client-event-1',
      payload: {
        category: 'pm',
        statement: '多人负责人需要一对一拆分 Jira 单。'
      }
    });

    const listResponse = await request(app)
      .get('/sync/events')
      .query({ since: 0 });

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toMatchObject({ lastVersion: 1 });
    expect(listResponse.body.data.events).toEqual([
      expect.objectContaining({
        version: 1,
        type: 'logic_assertion.created',
        clientId: 'desktop-client-api'
      })
    ]);

    const emptyDeltaResponse = await request(app)
      .get('/sync/events')
      .query({ since: 1 });

    expect(emptyDeltaResponse.status).toBe(200);
    expect(emptyDeltaResponse.body.data).toMatchObject({
      lastVersion: 1,
      events: []
    });
  });

  it('rejects unsupported sync event types through the API', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/sync/events')
      .send({
        type: 'unsupported.created',
        clientId: 'desktop-client-api',
        payload: { value: true }
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Unsupported sync event type.'
      }
    });
  });

  it('ignores request supplied baizeRoot for memory writes', async () => {
    const app = createApp();
    const maliciousRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-api-root-'));

    const response = await request(app)
      .post('/memory/shallow')
      .send({
        baizeRoot: maliciousRoot,
        category: 'general',
        content: 'API 根目录隔离测试。',
        source: 'manual'
      });

    expect(response.status).toBe(200);
    expect(response.body.data.file.startsWith(maliciousRoot)).toBe(false);
    await expect(fs.access(path.join(maliciousRoot, 'memory', 'shallow', 'general.md'))).rejects.toBeTruthy();
  });

  it('ignores request supplied baizeRoot for logic writes', async () => {
    const app = createApp();
    const maliciousRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-api-root-'));

    const response = await request(app)
      .post('/logic/assertions/draft')
      .send({
        baizeRoot: maliciousRoot,
        category: 'design',
        statement: 'API 逻辑根目录隔离测试。',
        source: 'passive_detected'
      });

    expect(response.status).toBe(200);
    expect(response.body.data.file.startsWith(maliciousRoot)).toBe(false);
    await expect(fs.access(path.join(maliciousRoot, 'logic', 'assertions', 'drafts.md'))).rejects.toBeTruthy();
  });

  it('returns validation error for unsupported shallow memory category', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/shallow')
      .send({
        category: 'unsupported',
        content: 'API 写入测试。',
        source: 'manual'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'INVALID_CATEGORY',
        message: 'Unsupported category.'
      }
    });
  });

  it('returns validation error for invalid JSON', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/shallow')
      .set('Content-Type', 'application/json')
      .send('{invalid');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON body.'
      }
    });
  });

  it('returns payload too large for oversized JSON bodies', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/shallow')
      .send({
        category: 'general',
        content: 'x'.repeat(300 * 1024),
        source: 'manual'
      });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large.'
      }
    });
  });

  it('returns validation error for missing shallow memory content', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/memory/shallow')
      .send({
        category: 'general',
        source: 'manual'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'content is required.'
      }
    });
  });

  it('handles desktop chat messages through the unified chat endpoint', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/chat')
      .send({
        text: '能量机制',
        userId: 'desktop-user',
        conversationId: 'desktop-conversation',
        platform: 'desktop'
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      provider: 'claude_code',
      message: {
        platform: 'desktop',
        userId: 'desktop-user',
        conversationId: 'desktop-conversation',
        text: '能量机制'
      }
    });
    expect(response.body.data.reply).toContain('白泽：');
  });

  it('streams desktop chat messages through the unified stream endpoint', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/chat/stream')
      .buffer(true)
      .send({
        text: '能量机制',
        userId: 'desktop-user',
        conversationId: 'desktop-stream-conversation',
        platform: 'desktop'
      });

    const events = response.text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data:'))
      .map((chunk) => JSON.parse(chunk.slice(5)));

    expect(response.status).toBe(200);
    expect(events.map((event) => event.type).filter((type) => type !== 'activity')).toEqual(['meta', 'delta', 'done']);
    expect(events.find((event) => event.type === 'delta').text).toContain('白泽：');
    expect(events.find((event) => event.type === 'done').conversation).toMatchObject({ id: 'desktop-stream-conversation' });
  });

  it('confirms Claude Code operations and stores patch proposals', async () => {
    const app = createApp();
    app.locals.claudeCodeRunner = async () => JSON.stringify({
      summary: '更新 app 文案。',
      patch: [
        'diff --git a/src/app.js b/src/app.js',
        '--- a/src/app.js',
        '+++ b/src/app.js',
        '@@ -1 +1 @@',
        '-old',
        '+new'
      ].join('\n')
    });
    const operation = await createPendingOperation({
      conversationId: 'api-operation-conversation',
      clientId: 'desktop-client-api',
      text: '帮我修改 src/app.js'
    }, { baizeRoot });

    const response = await request(app)
      .post(`/claude-code/operations/${operation.id}/confirm`)
      .send({
        conversationId: 'api-operation-conversation',
        clientId: 'desktop-client-api'
      });

    expect(response.status).toBe(200);
    expect(response.body.data.operation).toMatchObject({
      id: operation.id,
      status: 'awaiting_local_apply',
      proposal: {
        summary: '更新 app 文案。',
        files: [{ path: 'src/app.js', changeType: 'modify', additions: 1, deletions: 1 }]
      }
    });
  });

  it('uploads attachments and confirms memory through the API', async () => {
    const app = createApp();

    const uploadResponse = await request(app)
      .post('/attachments/upload')
      .send({
        fileName: 'api-notes.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('API 上传文件记忆测试。').toString('base64'),
        conversationId: 'api-upload-conversation',
        clientId: 'desktop-client-api'
      });

    expect(uploadResponse.status).toBe(200);
    expect(uploadResponse.body.data.attachment).toMatchObject({
      fileName: 'api-notes.txt',
      type: 'text',
      memory: { status: 'pending_confirmation' }
    });

    const rememberResponse = await request(app)
      .post(`/attachments/${uploadResponse.body.data.attachment.id}/remember`)
      .send({ category: 'project' });

    expect(rememberResponse.status).toBe(200);
    expect(rememberResponse.body.data.attachment.memory.status).toBe('remembered');
  });

  it('lists and loads persisted conversations through the API', async () => {
    const app = createApp();

    const chatResponse = await request(app)
      .post('/chat')
      .send({
        text: '会话 API 测试',
        userId: 'desktop-user',
        conversationId: 'api-conversation-test',
        clientId: 'desktop-client-api',
        platform: 'desktop'
      })
      .expect(200);

    const listResponse = await request(app)
      .get('/conversations')
      .query({ clientId: 'desktop-client-api' })
      .expect(200);
    const detailResponse = await request(app)
      .get('/conversations/api-conversation-test')
      .expect(200);

    expect(chatResponse.body.data.conversation).toMatchObject({ id: 'api-conversation-test' });
    expect(listResponse.body.data.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'api-conversation-test' })
    ]));
    expect(detailResponse.body.data.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', text: '会话 API 测试' }),
      expect.objectContaining({ role: 'assistant' })
    ]));
  });

  it('returns validation error for missing chat text', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/chat')
      .send({ text: '   ' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'text is required.'
      }
    });
  });

  it('routes chat through Claude Code fallback when Claude classification is unavailable', async () => {
    const app = createApp();
    const originalProvider = process.env.BAIZE_CHAT_PROVIDER;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.BAIZE_CHAT_PROVIDER = 'claude';
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const response = await request(app)
        .post('/chat')
        .send({ text: '能量机制' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        provider: 'claude_code'
      });
    } finally {
      if (originalProvider) {
        process.env.BAIZE_CHAT_PROVIDER = originalProvider;
      } else {
        delete process.env.BAIZE_CHAT_PROVIDER;
      }
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
    }
  });

  it('handles WeCom webhook messages that mention Baize', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/plugins/wecom/webhook')
      .send({
        msgtype: 'text',
        from: 'api-user',
        chatid: 'api-chat',
        text: {
          content: '白泽 能量机制'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      handled: true,
      provider: 'claude_code',
      message: {
        platform: 'wecom',
        userId: 'api-user',
        conversationId: 'api-chat',
        text: '能量机制'
      }
    });
    expect(response.body.data.reply).toContain('白泽：');
    expect(response.body.data.reply).toContain('Claude Code');
  });

  it('ignores WeCom webhook messages that do not mention Baize', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/plugins/wecom/webhook')
      .send({
        msgtype: 'text',
        text: {
          content: '能量机制'
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      handled: false,
      reason: 'not_mentioned'
    });
  });

  it('returns validation error for unsupported WeCom webhook messages', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/plugins/wecom/webhook')
      .send({
        msgtype: 'image',
        image: { media_id: 'media-1' }
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'msgtype must be text.'
      }
    });
  });

  it('returns Jira plugin status without leaking credentials', async () => {
    const app = createApp();
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  projectKey: BZ'
    ].join('\n'), 'utf8');

    const response = await request(app).get('/plugins/jira/status');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      implemented: true,
      enabled: true,
      credentialConfigured: true,
      ready: true,
      defaultProjectKey: 'BZ'
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-password');
  });

  it('returns Jira completion timing data through the search API', async () => {
    const app = createApp();
    let searchBody;
    app.locals.jiraFetch = async (url, options = {}) => {
      if (url.includes('/rest/api/2/user/search')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      searchBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          total: 1,
          issues: [{
            id: '10001',
            key: 'BUG-1',
            fields: {
              summary: '已完成 BUG',
              status: { name: '已解决', statusCategory: { name: 'Done', key: 'done' } },
              assignee: { displayName: '张三' },
              issuetype: { name: 'Bug' },
              project: { key: 'BUG' },
              created: '2026-05-01T00:00:00.000+0800',
              updated: '2026-05-03T00:00:00.000+0800',
              resolutiondate: '2026-05-02T00:00:00.000+0800',
              statuscategorychangedate: '2026-05-02T01:00:00.000+0800'
            }
          }]
        })
      };
    };
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  projectKey: BZ'
    ].join('\n'), 'utf8');

    const response = await request(app)
      .post('/plugins/jira/search')
      .send({
        projectKey: 'BUG',
        statusCategory: 'Done',
        maxResults: 10,
        orderBy: 'resolutiondate DESC, updated DESC',
        includeCompletionTiming: true,
        clientOperation: true,
        disableRecovery: true
      });

    expect(response.status).toBe(200);
    expect(searchBody.fields).toEqual(expect.arrayContaining(['resolutiondate', 'statuscategorychangedate']));
    expect(searchBody.jql).toContain('ORDER BY resolutiondate DESC, updated DESC');
    expect(response.body.data.issues[0].timing).toMatchObject({ completionSource: 'resolutiondate', completionDurationMs: 86400000 });
    expect(response.body.data.timingAnalysis).toMatchObject({
      totalIssues: 1,
      issuesWithCompletion: 1,
      averageCompletionDays: 1,
      completionSources: { resolutiondate: 1 }
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-password');
  });

  it('previews Jira import drafts and confirms creation through the API', async () => {
    const app = createApp();
    app.locals.jiraFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: '10001', key: 'BZ-1', self: 'https://jira.example.test/rest/api/3/issue/10001' })
    });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Story'
    ].join('\n'), 'utf8');

    const draftResponse = await request(app)
      .post('/plugins/jira/import-drafts')
      .send({
        fileName: '需求.txt',
        text: '批量 Jira 创建|确认后创建外部需求单',
        clientId: 'desktop-client-api',
        conversationId: 'jira-api-conversation'
      });

    expect(draftResponse.status).toBe(200);
    expect(draftResponse.body.data.operation).toMatchObject({
      kind: 'jira_bulk_create',
      status: 'awaiting_confirmation'
    });
    expect(draftResponse.body.data.drafts[0]).toMatchObject({ summary: '批量 Jira 创建', projectKey: 'BZ' });

    const structuredDraftResponse = await request(app)
      .post('/plugins/jira/import-drafts')
      .send({
        fileName: 'claude-code-jira-intent.json',
        drafts: [{ summary: '结构化 Jira 创建', description: '来自本机 Claude Code', projectKey: 'BZ', issueType: 'Story', labels: ['client'] }],
        clientId: 'desktop-client-api',
        conversationId: 'jira-api-structured-conversation'
      });

    expect(structuredDraftResponse.status).toBe(200);
    expect(structuredDraftResponse.body.data.operation).toMatchObject({
      kind: 'jira_bulk_create',
      status: 'awaiting_confirmation'
    });
    expect(structuredDraftResponse.body.data.drafts[0]).toMatchObject({ summary: '结构化 Jira 创建', description: '来自本机 Claude Code', projectKey: 'BZ', labels: ['client'] });

    const confirmResponse = await request(app)
      .post(`/plugins/jira/operations/${draftResponse.body.data.operation.id}/confirm`)
      .send({
        clientId: 'desktop-client-api',
        conversationId: 'jira-api-conversation'
      });

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.data.operation).toMatchObject({
      status: 'created',
      createdIssues: [expect.objectContaining({ key: 'BZ-1' })]
    });
  });

  it('asks the client to supplement project key through recovery before confirming Jira creation', async () => {
    const app = createApp();
    app.locals.claudeCodeRunner = async (input) => {
      if (input.permissionMode === 'plugin_operation_error_analysis') {
        return JSON.stringify({
          kind: 'plugin_operation_recovery',
          plugin: 'jira',
          operationId: input.operation.id,
          status: 'needs_user_input',
          summary: '创建 Jira 前需要补充项目 Key。',
          reason: '当前草稿缺少 projectKey。',
          supplement: {
            prompt: '请填写这些 Jira 单要创建到哪个项目 Key。',
            inputs: [{ id: 'projectKey', type: 'text', label: '项目 Key', required: true }]
          },
          actions: [{ id: 'submit_supplement', label: '提交项目 Key', style: 'primary' }, { id: 'cancel', label: '取消创建' }]
        });
      }
      return JSON.stringify({ kind: 'jira_confirmed_execute', operationId: input.operation.id, action: 'create' });
    };
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  issueType: Story'
    ].join('\n'), 'utf8');
    const operation = await createJiraCreateOperation({
      fileName: '需求.txt',
      count: 1,
      clientId: 'desktop-client-api',
      conversationId: 'jira-api-project-required-conversation',
      drafts: [{ summary: '缺项目 Jira 创建', description: '确认前补充项目', issueType: 'Story', labels: [] }],
      warnings: ['存在未配置项目 Key 的草稿，确认创建前需要补充项目。']
    }, { baizeRoot });

    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');

    const confirmResponse = await request(app)
      .post(`/plugins/jira/operations/${operation.id}/confirm`)
      .send({ clientId: 'desktop-client-api', conversationId: 'jira-api-project-required-conversation' });

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.data.operation).toMatchObject({
      status: 'recovery_required',
      failure: { code: 'JIRA_PROJECT_REQUIRED' },
      recovery: {
        status: 'needs_user_input',
        analyzedBy: 'claude_code',
        supplement: { inputs: [expect.objectContaining({ id: 'projectKey' })] },
        actions: expect.arrayContaining([expect.objectContaining({ id: 'submit_supplement' })])
      }
    });

    app.locals.jiraFetch = async (url) => {
      if (url.endsWith('/rest/api/2/project/BATTLE')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ key: 'BATTLE', name: 'Battle 项目', issueTypes: [{ id: '10001', name: 'Story' }] })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    };
    const updateResponse = await request(app)
      .post(`/plugins/jira/operations/${operation.id}/recovery`)
      .send({ clientId: 'desktop-client-api', conversationId: 'jira-api-project-required-conversation', actionId: 'submit_supplement', inputs: { projectKey: 'BATTLE' } });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.operation).toMatchObject({ status: 'awaiting_confirmation' });
    expect(updateResponse.body.data.operation.draftImport.drafts[0]).toMatchObject({ projectKey: 'BATTLE' });
    expect(updateResponse.body.data.operation.draftImport.warnings).toEqual([]);
  });

  it('returns Jira recovery options and applies retry_without_labels through the API', async () => {
    const app = createApp();
    const createRequests = [];
    let shouldFail = true;
    app.locals.jiraFetch = async (url, options = {}) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ issueTypes: [{ id: '10001', name: 'Story' }] })
        };
      }
      createRequests.push(JSON.parse(options.body).fields);
      if (shouldFail) {
        shouldFail = false;
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({
            errorMessages: [],
            errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: '10002', key: 'BZ-2', self: 'https://jira.example.test/rest/api/2/issue/10002' })
      };
    };
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Story'
    ].join('\n'), 'utf8');

    const operation = await createJiraCreateOperation({
      fileName: '需求.txt',
      count: 1,
      clientId: 'desktop-client-api',
      conversationId: 'jira-api-recovery-conversation',
      drafts: [{ summary: '带标签 Jira 创建', description: '确认后创建外部需求单', projectKey: 'BZ', issueType: 'Story', labels: ['baize'] }]
    }, { baizeRoot });
    const operationId = operation.id;

    const confirmResponse = await request(app)
      .post(`/plugins/jira/operations/${operationId}/confirm`)
      .send({ clientId: 'desktop-client-api', conversationId: 'jira-api-recovery-conversation' });

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.data.operation).toMatchObject({
      status: 'recovery_required',
      recovery: {
        status: 'available',
        actions: expect.arrayContaining([expect.objectContaining({ id: 'retry_without_labels' })])
      }
    });

    const recoveryResponse = await request(app)
      .post(`/plugins/jira/operations/${operationId}/recovery`)
      .send({ clientId: 'desktop-client-api', conversationId: 'jira-api-recovery-conversation', actionId: 'retry_without_labels' });

    expect(recoveryResponse.status).toBe(200);
    expect(recoveryResponse.body.data.operation).toMatchObject({
      status: 'created',
      createdIssues: [expect.objectContaining({ key: 'BZ-2' })]
    });
    expect(createRequests[0].labels).toEqual(['baize']);
    expect(createRequests[1].labels).toBeUndefined();
  });

  it('checks Claude Code confirmed intent before API Jira card confirmation when enabled', async () => {
    const app = createApp();
    const runnerInputs = [];
    app.locals.claudeCodeRunner = async (input) => {
      runnerInputs.push(input);
      return JSON.stringify({ kind: 'jira_confirmed_execute', operationId: input.operation.id, action: 'create' });
    };
    app.locals.jiraFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: '10001', key: 'BZ-1', self: 'https://jira.example.test/rest/api/3/issue/10001' })
    });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), 'enabled: true\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Story'
    ].join('\n'), 'utf8');

    const draftResponse = await request(app)
      .post('/plugins/jira/import-drafts')
      .send({
        fileName: '需求.txt',
        text: '批量 Jira 创建|确认后创建外部需求单',
        clientId: 'desktop-client-api',
        conversationId: 'jira-api-claude-code-confirm-conversation'
      });
    const operationId = draftResponse.body.data.operation.id;

    const confirmResponse = await request(app)
      .post(`/plugins/jira/operations/${operationId}/confirm`)
      .send({
        clientId: 'desktop-client-api',
        conversationId: 'jira-api-claude-code-confirm-conversation'
      });

    expect(confirmResponse.status).toBe(200);
    expect(runnerInputs).toHaveLength(1);
    expect(runnerInputs[0].permissionMode).toBe('confirmed_operation_intent');
    expect(runnerInputs[0].operation.id).toBe(operationId);
    expect(confirmResponse.body.data.operation).toMatchObject({
      status: 'created',
      createdIssues: [expect.objectContaining({ key: 'BZ-1' })]
    });
  });

  it('returns knowledge base status', async () => {
    const app = createApp();

    const response = await request(app).get('/plugins/knowledge-base/status');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      implemented: true,
      mode: 'local_markdown'
    });
    expect(response.body.data.documentCount).toBeGreaterThan(0);
  });

  it('searches knowledge base documents', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/plugins/knowledge-base/search')
      .query({ q: '能量机制' });

    expect(response.status).toBe(200);
    expect(response.body.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'combat',
          snippet: expect.stringContaining('能量机制')
        })
      ])
    );
  });

  it('creates and confirms a Jira Bug analysis run through the API', async () => {
    const app = createApp();
    app.locals.jiraFetch = async (url) => {
      if (url.endsWith('/rest/api/2/search')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            total: 1,
            issues: [{ key: 'BZ-99', id: '10099', fields: { summary: '客户端崩溃', status: { name: 'Open' } } }]
          })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    };
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password'
    ].join('\n'), 'utf8');

    const createResponse = await request(app)
      .post('/plugins/jira/bug-analysis/runs')
      .send({ projectKey: 'BZ', clientId: 'desktop-client-api' });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.data.run).toMatchObject({ status: 'awaiting_confirmation', total: 1 });
    expect(createResponse.body.data.run.items[0]).toMatchObject({ issueKey: 'BZ-99', status: 'pending' });

    const confirmResponse = await request(app)
      .post(`/plugins/jira/bug-analysis/runs/${createResponse.body.data.run.id}/confirm`)
      .send({ clientId: 'desktop-client-api' });

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.data.run.status).toBe('running');
  });

  it('returns validation error for missing knowledge base query', async () => {
    const app = createApp();

    const response = await request(app).get('/plugins/knowledge-base/search');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'q is required.'
      }
    });
  });

  it('registers a knowledge base document into deep memory index', async () => {
    const app = createApp();
    const documentPath = path.join(baizeRoot, 'docs', 'combat.md');

    const response = await request(app)
      .post('/plugins/knowledge-base/deep-index')
      .send({
        category: 'project',
        title: '战斗系统',
        path: documentPath,
        tags: ['知识库', '战斗'],
        summary: '战斗系统知识库文档。'
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      category: 'project',
      pathExists: true
    });
  });

  it('rejects knowledge base deep index paths outside baize root', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/plugins/knowledge-base/deep-index')
      .send({
        category: 'project',
        title: '外部文档',
        path: 'G:/Robot/outside-knowledge.md',
        summary: '拒绝登记外部知识库文档。'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'path must be inside baize root.'
      }
    });
  });

  it('returns json 404 for unknown routes', async () => {
    const app = createApp();

    const response = await request(app).get('/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.'
      }
    });
  });
});
