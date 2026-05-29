const fs = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const XLSX = require('xlsx');
const { createAnthropicClient, generateChatRouteClassification, generateClaudeReply, generateClaudeReplyStream, analyzeImageAttachment, generateJiraDraftTextFromXlsx } = require('../src/services/claude-service');
const { createTestRoot } = require('./helpers/test-root');

describe('claude service', () => {
  it('creates Anthropic client with configured base URL', () => {
    const client = createAnthropicClient({
      apiKey: 'test-key',
      baseURL: 'https://claude.example.test'
    });

    expect(client.baseURL).toBe('https://claude.example.test');
  });

  it('creates Anthropic client with auth token when no API key is configured', () => {
    const client = createAnthropicClient({
      authToken: 'test-token',
      baseURL: 'https://claude.example.test'
    });

    expect(client.apiKey).toBeNull();
    expect(client.authToken).toBe('test-token');
    expect(client.baseURL).toBe('https://claude.example.test');
  });

  it('uses model from server Claude config without real network calls', async () => {
    const { baizeRoot } = await createTestRoot();
    let request;
    const client = {
      messages: {
        create: async (input) => {
          request = input;
          return { content: [{ type: 'text', text: '白泽：配置模型测试。' }] };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.md'), '# 白泽全局设定\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.yaml'), '', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), [
      'provider: claude',
      'claude:',
      '  apiKey: test-key',
      '  baseURL: https://claude.example.test',
      '  model: claude-opus-4-7'
    ].join('\n'), 'utf8');

    const reply = await generateClaudeReply({
      message: {
        platform: 'desktop',
        userId: 'user-1',
        conversationId: 'conversation-1',
        text: '能量机制'
      },
      knowledgeResults: [],
      baizeRoot,
      client
    });

    expect(reply).toBe('白泽：配置模型测试。');
    expect(request.model).toBe('claude-opus-4-7');
    expect(request.thinking).toEqual({ type: 'adaptive' });
  });

  it('formats full Baize context into Claude request without real network calls', async () => {
    const { baizeRoot } = await createTestRoot();
    let request;
    const client = {
      messages: {
        create: async (input) => {
          request = input;
          return { content: [{ type: 'text', text: '白泽：完整上下文测试。' }] };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.md'), '# 白泽全局设定\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.yaml'), '', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');

    await generateClaudeReply({
      message: {
        platform: 'desktop',
        userId: 'desktop-user',
        conversationId: 'conversation-1',
        text: '你好'
      },
      knowledgeResults: [
        {
          title: 'combat',
          relativePath: path.join('docs', 'combat.md'),
          snippet: '能量机制说明。'
        }
      ],
      shallowMemoryResults: [
        { category: 'project', line: '能量机制属于战斗系统。' }
      ],
      logicContext: {
        assertions: [
          { category: 'identity', relativePath: path.join('logic', 'assertions', 'identity.md'), content: '白泽保持项目智能中枢身份。' }
        ],
        rules: [
          { name: 'intent-routing', relativePath: path.join('logic', 'rules', 'intent-routing.md'), content: '优先识别用户目标。' }
        ],
        executableRules: [
          { name: 'routing-rules', relativePath: path.join('logic', 'executable', 'routing-rules.yaml'), content: 'rules:\n  - name: route-chat' }
        ]
      },
      skillsContext: {
        registry: 'skills:\n  - id: wecom',
        skills: [
          {
            id: 'wecom',
            relativePath: path.join('skills', 'wecom'),
            skillMarkdown: '# 企业微信技能',
            configYaml: 'enabled: true'
          }
        ]
      },
      baizeRoot,
      client
    });

    const text = request.messages[0].content[0].text;
    expect(text).toContain('本地知识库上下文');
    expect(text).toContain('combat');
    expect(text).toContain('浅层记忆上下文');
    expect(text).toContain('能量机制属于战斗系统');
    expect(text).toContain('逻辑断言与规则上下文');
    expect(text).toContain('项目智能中枢身份');
    expect(text).toContain('技能上下文');
    expect(text).toContain('企业微信技能');
    expect(text).toContain('用户问题：你好');
  });

  it('sends recent conversation history before the current question', async () => {
    const { baizeRoot } = await createTestRoot();
    let request;
    const client = {
      messages: {
        create: async (input) => {
          request = input;
          return { content: [{ type: 'text', text: '白泽：历史上下文测试。' }] };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.md'), '# 白泽全局设定\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.yaml'), '', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');

    await generateClaudeReply({
      message: {
        platform: 'desktop',
        userId: 'desktop-user',
        conversationId: 'conversation-1',
        text: '我刚才说我是谁？'
      },
      knowledgeResults: [],
      conversationMessages: [
        { role: 'user', text: '我是 JUMP 群英集结的项目大管家。' },
        { role: 'assistant', text: '白泽已记录。' }
      ],
      baizeRoot,
      client
    });

    expect(request.messages[1]).toMatchObject({ role: 'user' });
    expect(request.messages[1].content[0].text).toContain('项目大管家');
    expect(request.messages[2]).toMatchObject({ role: 'assistant' });
    expect(request.messages[3].content[0].text).toContain('我刚才说我是谁');
  });

  it('streams Claude text deltas without real network calls', async () => {
    const { baizeRoot } = await createTestRoot();
    const deltas = [];
    let request;
    const client = {
      messages: {
        stream: (input) => {
          request = input;
          const stream = new EventEmitter();
          stream.finalMessage = async () => {
            stream.emit('text', '白泽：');
            stream.emit('text', '流式回复。');
            return { content: [{ type: 'text', text: '白泽：流式回复。' }] };
          };
          return stream;
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.md'), '# 白泽全局设定\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'global.yaml'), '', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');

    const reply = await generateClaudeReplyStream({
      message: {
        platform: 'desktop',
        userId: 'desktop-user',
        conversationId: 'conversation-1',
        text: '你好'
      },
      knowledgeResults: [],
      baizeRoot,
      client,
      onDelta: (text) => deltas.push(text)
    });

    expect(request.model).toBe('claude-opus-4-7');
    expect(deltas).toEqual(['白泽：', '流式回复。']);
    expect(reply).toBe('白泽：流式回复。');
  });

  it('uploads xlsx files for Claude code execution Jira parsing', async () => {
    const { baizeRoot } = await createTestRoot();
    let uploadFile;
    let request;
    let options;
    const client = {
      beta: {
        files: {
          upload: async (input) => {
            uploadFile = input.file;
            return { id: 'file_123' };
          }
        }
      },
      messages: {
        create: async (input, requestOptions) => {
          request = input;
          options = requestOptions;
          return { content: [{ type: 'text', text: '标题：批量创建 Jira\n负责人：张三' }] };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n  model: claude-opus-4-7\n', 'utf8');

    const text = await generateJiraDraftTextFromXlsx({
      fileName: '需求.xlsx',
      buffer: Buffer.from('fake-xlsx'),
      userText: '创建 Jira',
      baizeRoot,
      client
    });

    expect(uploadFile.name).toBe('需求.xlsx');
    expect(request.tools).toEqual([{ name: 'code_execution', type: 'code_execution_20250522' }]);
    expect(request.messages[0].content[0]).toEqual({ type: 'container_upload', file_id: 'file_123' });
    expect(request.messages[0].content[1].text).toContain('创建 Jira');
    expect(options.headers['anthropic-beta']).toBe('code-execution-2025-05-22');
    expect(text).toBe('标题：批量创建 Jira\n负责人：张三');
  });

  it('falls back to workbook text when Claude file upload is unavailable', async () => {
    const { baizeRoot } = await createTestRoot();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 标题: 'JUMP 登录优化', 负责人: '曾浩然' }
    ]), '需求');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    let request;
    const client = {
      beta: {
        files: {
          upload: async () => {
            const error = new Error('404 page not found');
            error.status = 404;
            throw error;
          }
        }
      },
      messages: {
        create: async (input) => {
          request = input;
          return { content: [{ type: 'text', text: '标题：JUMP 登录优化\n负责人：曾浩然' }] };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n  model: claude-opus-4-7\n', 'utf8');

    const text = await generateJiraDraftTextFromXlsx({
      fileName: 'JUMP需求收集表.xlsx',
      buffer,
      userText: '根据文件创建jira需求',
      baizeRoot,
      client
    });

    expect(text).toContain('JUMP 登录优化');
    expect(request.tools).toBeUndefined();
    expect(request.messages[0].content[0].text).toContain('工作表：需求');
    expect(request.messages[0].content[0].text).toContain('JUMP 登录优化');
  });

  it('classifies chat routes through Claude with normalized confirmation rules', async () => {
    const { baizeRoot } = await createTestRoot();
    let request;
    const client = {
      messages: {
        create: async (input) => {
          request = input;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                route: 'operation',
                confidence: 0.92,
                reason: '用户要求根据表格创建 Jira 需求',
                requiresConfirmation: true
              })
            }]
          };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n  model: claude-opus-4-7\n', 'utf8');

    const classification = await generateChatRouteClassification({
      message: {
        platform: 'desktop',
        conversationId: 'conversation-1',
        text: '根据这个文档创建对应的 jira 需求'
      },
      knowledgeResults: [{ title: 'JUMP需求收集表', relativePath: 'uploads/JUMP.xlsx', snippet: '需求表格' }],
      conversationMessages: [{ role: 'user', text: '我上传了 Excel' }],
      conversationSummary: '用户正在创建 Jira。',
      baizeRoot,
      client
    });

    expect(request.model).toBe('claude-opus-4-7');
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.system[0].text).toContain('route 只能是');
    expect(request.messages[0].content[0].text).toContain('根据这个文档创建对应的 jira 需求');
    expect(classification).toEqual({
      route: 'operation',
      confidence: 0.92,
      reason: '用户要求根据表格创建 Jira 需求',
      requiresConfirmation: true
    });
  });

  it('returns null for invalid chat route classification output', async () => {
    const { baizeRoot } = await createTestRoot();
    const client = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: '{"route":"unknown","confidence":1}' }] })
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');

    await expect(generateChatRouteClassification({
      message: { platform: 'desktop', text: 'hello' },
      baizeRoot,
      client
    })).resolves.toBeNull();
  });

  it('returns a Chinese configuration error when image analysis authentication fails', async () => {
    const { baizeRoot } = await createTestRoot();
    const error = new Error('401 {"error":"Invalid API key"}');
    error.status = 401;
    const client = {
      messages: {
        create: async () => {
          throw error;
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n', 'utf8');

    await expect(analyzeImageAttachment({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-png').toString('base64'),
      baizeRoot,
      client
    })).rejects.toMatchObject({
      publicMessage: '服务器大模型认证失败：Claude API Key 或 Auth Token 无效，请检查服务器 Claude 配置。'
    });
  });

  it('analyzes images through the configured Claude model without real network calls', async () => {
    const { baizeRoot } = await createTestRoot();
    let request;
    const client = {
      messages: {
        create: async (input) => {
          request = input;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                summary: '图片显示白泽客户端连接失败提示。',
                memoryCategory: 'project',
                shouldRemember: true,
                reason: '这是排查客户端问题的上下文。',
                extractedText: '连接服务器失败'
              })
            }]
          };
        }
      }
    };

    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), 'provider: claude\nclaude:\n  apiKey: test-key\n  model: claude-opus-4-7\n', 'utf8');

    const analysis = await analyzeImageAttachment({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-png').toString('base64'),
      baizeRoot,
      client
    });

    expect(request.model).toBe('claude-opus-4-7');
    expect(request.messages[0].content[0]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('fake-png').toString('base64')
      }
    });
    expect(request.messages[0].content[1].text).toContain('文件名：screenshot.png');
    expect(analysis).toEqual({
      summary: '图片显示白泽客户端连接失败提示。',
      memoryCategory: 'project',
      shouldRemember: true,
      reason: '这是排查客户端问题的上下文。',
      extractedText: '连接服务器失败'
    });
  });
});
