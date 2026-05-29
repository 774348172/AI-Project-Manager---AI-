const fs = require('fs');
const path = require('path');
const { buildLocalClaudeCodePrompt, buildLocalImageAnalysisPrompt, createLocalClaudeCodeRunner, createLocalClaudeCodeChat, parseLocalClaudeCodeOutput, parseLocalImageAnalysisOutput, analyzeLocalImageAttachment, resolveClaudeCodeCommand } = require('../client/desktop/local-claude-code.cjs');

describe('desktop local Claude Code output parsing', () => {
  it('builds a local image analysis prompt without leaking secrets into expected output', () => {
    const prompt = buildLocalImageAnalysisPrompt({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      size: 1024,
      localPath: 'D:/tmp/screenshot.png'
    });

    expect(prompt).toContain('本机可读取路径：D:/tmp/screenshot.png');
    expect(prompt).toContain('只输出 JSON');
    expect(prompt).toContain('不要输出 syncEvents');
    expect(prompt).toContain('不要输出 clientOperations');
    expect(prompt).toContain('不要把本机路径');
  });

  it('parses local image analysis JSON and strips unsupported fields', () => {
    const analysis = parseLocalImageAnalysisOutput('```json\n{"summary":"图片展示报错","memoryCategory":"project","shouldRemember":true,"reason":"有调试价值","extractedText":"Invalid API key","localPath":"D:/tmp/a.png","token":"secret"}\n```');

    expect(analysis).toEqual({
      provider: 'local_claude_code',
      summary: '图片展示报错',
      memoryCategory: 'project',
      shouldRemember: true,
      reason: '有调试价值',
      extractedText: 'Invalid API key'
    });
    expect(JSON.stringify(analysis)).not.toContain('D:/tmp');
    expect(JSON.stringify(analysis)).not.toContain('secret');
  });

  it('runs one-shot local image analysis with env only in process environment', async () => {
    let runInput;
    const runner = async (input) => {
      runInput = input;
      return { output: JSON.stringify({ summary: '图片展示客户端界面', memoryCategory: 'project', shouldRemember: true, reason: '有项目上下文', extractedText: '白泽' }) };
    };

    const analysis = await analyzeLocalImageAttachment({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      size: 2048,
      localPath: 'D:/tmp/screenshot.png'
    }, {
      runner,
      localClaudeCodeEnv: { ANTHROPIC_AUTH_TOKEN: 'server-token' }
    });

    expect(analysis.summary).toBe('图片展示客户端界面');
    expect(runInput.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'server-token' });
    expect(runInput.prompt).not.toContain('server-token');
  });

  it('includes local readable paths for dragged attachments in the prompt', () => {
    const prompt = buildLocalClaudeCodePrompt({
      text: '读取这个文件',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1',
      attachmentIds: ['att-1'],
      localAttachments: [{
        id: 'att-1',
        name: '需求.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 128,
        source: 'file',
        localPath: 'D:/Users/me/Desktop/需求.xlsx'
      }]
    });

    expect(prompt).toContain('附件上下文');
    expect(prompt).toContain('附件 ID：att-1');
    expect(prompt).toContain('需求.xlsx');
    expect(prompt).toContain('MIME：application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(prompt).toContain('大小：128 bytes');
    expect(prompt).toContain('来源：file');
    expect(prompt).toContain('本机可读取路径：D:/Users/me/Desktop/需求.xlsx');
    expect(prompt).toContain('不要用 Read 直接读取二进制内容');
    expect(prompt).toContain('node -e 单行命令');
    expect(prompt).toContain('解析建议：这是 Excel 文件');
  });

  it('does not invent local paths for pasted data attachments', () => {
    const prompt = buildLocalClaudeCodePrompt({
      text: '分析截图',
      attachmentIds: ['att-2'],
      localAttachments: [{
        id: 'att-2',
        name: 'clipboard-image.png',
        mime: 'image/png',
        size: 256,
        source: 'data'
      }]
    });

    expect(prompt).toContain('clipboard-image.png');
    expect(prompt).toContain('来源：data');
    expect(prompt).toContain('本机可读取路径：无');
    expect(prompt).not.toContain('本机可读取路径：clipboard-image.png');
  });

  it('resolves packaged Claude Code before terminal PATH', () => {
    const originalAppData = process.env.APPDATA;
    const originalCommand = process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND;
    process.env.APPDATA = path.join(__dirname, '..', 'missing-app-data');
    delete process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND;

    try {
      const resolved = resolveClaudeCodeCommand('claude');
      expect(resolved).toContain(path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    } finally {
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      if (originalCommand === undefined) {
        delete process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND;
      } else {
        process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND = originalCommand;
      }
    }
  });

  it('checks app.asar.unpacked before app.asar in packaged Electron builds', () => {
    const originalResourcesPath = process.resourcesPath;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => String(candidate).includes('app.asar.unpacked'));
    Object.defineProperty(process, 'resourcesPath', {
      value: 'F:/baizi/baize-local-hub/resources',
      configurable: true
    });

    try {
      const resolved = resolveClaudeCodeCommand('claude');
      expect(resolved).toContain('app.asar.unpacked');
      expect(resolved).not.toContain('app.asar/node_modules');
    } finally {
      existsSpy.mockRestore();
      Object.defineProperty(process, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true
      });
    }
  });

  it('does not use app.asar virtual paths even if they appear to exist', () => {
    const originalResourcesPath = process.resourcesPath;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => String(candidate).includes('app.asar'));
    Object.defineProperty(process, 'resourcesPath', {
      value: 'F:/baizi/baize-local-hub/resources',
      configurable: true
    });

    try {
      const resolved = resolveClaudeCodeCommand('claude');
      expect(resolved).toContain('app.asar.unpacked');
      expect(resolved).not.toContain('app.asar/node_modules');
    } finally {
      existsSpy.mockRestore();
      Object.defineProperty(process, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true
      });
    }
  });

  it('allows environment command override before packaged Claude Code', () => {
    const originalCommand = process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND;
    process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND = 'custom-claude';

    try {
      expect(resolveClaudeCodeCommand('custom-claude')).toBe('custom-claude');
      expect(resolveClaudeCodeCommand()).toBe('custom-claude');
    } finally {
      if (originalCommand === undefined) {
        delete process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND;
      } else {
        process.env.BAIZE_DESKTOP_CLAUDE_CODE_COMMAND = originalCommand;
      }
    }
  });

  it('runs local Claude Code with default tools for normal requests', async () => {
    let spawned;
    const runner = createLocalClaudeCodeRunner({
      command: 'custom-claude',
      spawnImpl: (command, args, options) => {
        spawned = { command, args, options };
        const listeners = {};
        const child = {
          stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; } },
          stderr: { on: (event, handler) => { listeners[`stderr:${event}`] = handler; } },
          on: (event, handler) => { listeners[event] = handler; },
          kill: () => {}
        };
        setTimeout(() => {
          listeners['stdout:data'] && listeners['stdout:data'](Buffer.from('白泽：完成。'));
          listeners.close && listeners.close(0);
        }, 0);
        return child;
      }
    });

    const result = await runner({ prompt: '你好' });

    expect(result).toEqual({ output: '白泽：完成。', sessionId: '' });
    expect(spawned.command).toBe('custom-claude');
    expect(spawned.args).toEqual(expect.arrayContaining([
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'default'
    ]));
    expect(spawned.args).not.toContain('Read,Grep,Glob,Bash,Edit,Write');
  });

  it('passes long prompts through stdin instead of command arguments', async () => {
    let spawned;
    let stdinText = '';
    const longPrompt = `根据文档创建 Jira 单\n${'表格内容'.repeat(20000)}`;
    const runner = createLocalClaudeCodeRunner({
      command: 'custom-claude',
      spawnImpl: (command, args, options) => {
        spawned = { command, args, options };
        const listeners = {};
        const child = {
          stdin: { end: (value) => { stdinText = String(value); } },
          stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; } },
          stderr: { on: (event, handler) => { listeners[`stderr:${event}`] = handler; } },
          on: (event, handler) => { listeners[event] = handler; },
          kill: () => {}
        };
        setTimeout(() => {
          listeners['stdout:data'] && listeners['stdout:data'](Buffer.from('白泽：完成。'));
          listeners.close && listeners.close(0);
        }, 0);
        return child;
      }
    });

    const result = await runner({ prompt: longPrompt });

    expect(result).toEqual({ output: '白泽：完成。', sessionId: '' });
    expect(spawned.args).toContain('--print');
    expect(spawned.args).not.toContain(longPrompt);
    expect(spawned.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(stdinText).toBe(longPrompt);
  });

  it('restricts local Claude Code tools only when requested', async () => {
    let spawned;
    const runner = createLocalClaudeCodeRunner({
      command: 'custom-claude',
      spawnImpl: (command, args, options) => {
        spawned = { command, args, options };
        const listeners = {};
        const child = {
          stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; } },
          stderr: { on: (event, handler) => { listeners[`stderr:${event}`] = handler; } },
          on: (event, handler) => { listeners[event] = handler; },
          kill: () => {}
        };
        setTimeout(() => {
          listeners['stdout:data'] && listeners['stdout:data'](Buffer.from('白泽：完成。'));
          listeners.close && listeners.close(0);
        }, 0);
        return child;
      }
    });

    await runner({ prompt: '解析 xlsx', restrictTools: true });

    expect(spawned.args).toEqual(expect.arrayContaining([
      '--tools',
      'Read,Grep,Glob,Bash,Edit,Write'
    ]));
    expect(spawned.args).not.toContain('default');
  });

  it('passes server Claude Code env only to the spawned process environment', async () => {
    let spawned;
    const runner = createLocalClaudeCodeRunner({
      command: 'custom-claude',
      spawnImpl: (command, args, options) => {
        spawned = { command, args, options };
        const listeners = {};
        const child = {
          stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; } },
          stderr: { on: (event, handler) => { listeners[`stderr:${event}`] = handler; } },
          on: (event, handler) => { listeners[event] = handler; },
          kill: () => {}
        };
        setTimeout(() => {
          listeners['stdout:data'] && listeners['stdout:data'](Buffer.from('白泽：完成。'));
          listeners.close && listeners.close(0);
        }, 0);
        return child;
      }
    });

    const result = await runner({
      prompt: '你好',
      env: {
        ANTHROPIC_AUTH_TOKEN: 'server-token',
        ANTHROPIC_BASE_URL: 'http://claude.example.test',
        EMPTY_VALUE: ''
      }
    });

    expect(result).toEqual({ output: '白泽：完成。', sessionId: '' });
    expect(spawned.options.env.ANTHROPIC_AUTH_TOKEN).toBe('server-token');
    expect(spawned.options.env.ANTHROPIC_BASE_URL).toBe('http://claude.example.test');
    expect(spawned.options.env.EMPTY_VALUE).toBeUndefined();
    expect(JSON.stringify(spawned.args)).not.toContain('server-token');
  });

  it('streams visible Claude Code events from stream-json output', async () => {
    const events = [];
    const runner = createLocalClaudeCodeRunner({
      command: 'custom-claude',
      spawnImpl: (command, args) => {
        const listeners = {};
        const child = {
          stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; } },
          stderr: { on: (event, handler) => { listeners[`stderr:${event}`] = handler; } },
          on: (event, handler) => { listeners[event] = handler; },
          kill: () => {}
        };
        setTimeout(() => {
          [
            { type: 'system', subtype: 'init', session_id: 'session-1' },
            { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'D:/tmp/需求.xlsx' } }] } },
            { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '白泽：' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成。' } } },
            { type: 'result', subtype: 'success', result: '白泽：完成。', duration_ms: 1200 }
          ].forEach((item) => listeners['stdout:data'] && listeners['stdout:data'](Buffer.from(`${JSON.stringify(item)}\n`)));
          listeners.close && listeners.close(0);
        }, 0);
        return child;
      }
    });

    const result = await runner({ prompt: '你好', streamJson: true, onEvent: (event) => events.push(event) });

    expect(result).toEqual({ output: '白泽：完成。', sessionId: 'session-1' });
    expect(events).toEqual([
      { type: 'status', message: '本机 Claude Code 已启动，会话 session-1' },
      { type: 'status', message: 'Claude Code 正在读取文件：需求.xlsx' },
      { type: 'status', message: 'Claude Code 已收到 1 个工具结果，正在继续分析。' },
      { type: 'delta', text: '白泽：' },
      { type: 'delta', text: '完成。' },
      { type: 'status', message: 'Claude Code 执行完成，耗时 1 秒。' }
    ]);
  });

  it('passes resume session id to Claude Code CLI', async () => {
    let spawned;
    const runner = createLocalClaudeCodeRunner({
      command: 'custom-claude',
      spawnImpl: (command, args) => {
        spawned = { command, args };
        const listeners = {};
        const child = {
          stdout: { on: (event, handler) => { listeners[`stdout:${event}`] = handler; } },
          stderr: { on: (event, handler) => { listeners[`stderr:${event}`] = handler; } },
          on: (event, handler) => { listeners[event] = handler; },
          kill: () => {}
        };
        setTimeout(() => {
          listeners['stdout:data'] && listeners['stdout:data'](Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-2' })}\n`));
          listeners['stdout:data'] && listeners['stdout:data'](Buffer.from(`${JSON.stringify({ type: 'result', result: '白泽：继续。' })}\n`));
          listeners.close && listeners.close(0);
        }, 0);
        return child;
      }
    });

    const result = await runner({ prompt: '继续', streamJson: true, resumeSessionId: 'session-1' });

    expect(result).toEqual({ output: '白泽：继续。', sessionId: 'session-2' });
    expect(spawned.args).toEqual(expect.arrayContaining(['--resume', 'session-1']));
  });

  it('reuses saved Claude Code sessions for the same conversation', async () => {
    const calls = [];
    const sessions = new Map();
    const chat = createLocalClaudeCodeChat({
      sessionStore: {
        get: async (conversationId) => sessions.get(conversationId) || '',
        set: async (conversationId, sessionId) => sessions.set(conversationId, sessionId)
      },
      runner: async (input) => {
        calls.push(input);
        return { output: `白泽：第 ${calls.length} 次回复。`, sessionId: `session-${calls.length}` };
      }
    });

    await chat.send({ text: '第一句', conversationId: 'conversation-1', clientId: 'desktop-client-1' });
    await chat.send({ text: '追问', conversationId: 'conversation-1', clientId: 'desktop-client-1' });
    await chat.send({ text: '另一个会话', conversationId: 'conversation-2', clientId: 'desktop-client-1' });

    expect(calls.map((call) => ({ resumeSessionId: call.resumeSessionId, streamJson: call.streamJson }))).toEqual([
      { resumeSessionId: '', streamJson: true },
      { resumeSessionId: 'session-1', streamJson: true },
      { resumeSessionId: '', streamJson: true }
    ]);
    expect(sessions.get('conversation-1')).toBe('session-2');
    expect(sessions.get('conversation-2')).toBe('session-3');
  });

  it('reuses saved Claude Code sessions for streamed chat', async () => {
    const calls = [];
    const events = [];
    const sessions = new Map([['conversation-1', 'session-1']]);
    const chat = createLocalClaudeCodeChat({
      sessionStore: {
        get: async (conversationId) => sessions.get(conversationId) || '',
        set: async (conversationId, sessionId) => sessions.set(conversationId, sessionId)
      },
      runner: async (input) => {
        calls.push(input);
        input.onEvent && input.onEvent({ type: 'delta', text: '白泽：继续。' });
        return { output: '白泽：继续。', sessionId: 'session-2' };
      }
    });

    const result = await chat.sendStream({ text: '继续', conversationId: 'conversation-1', clientId: 'desktop-client-1' }, {
      onEvent: (event) => events.push(event)
    });

    expect(calls[0].resumeSessionId).toBe('session-1');
    expect(calls[0].streamJson).toBe(true);
    expect(sessions.get('conversation-1')).toBe('session-2');
    expect(events).toEqual([
      { type: 'status', message: '白泽正在调用本机 Claude Code，全本地文件工具权限已启用。' },
      { type: 'delta', text: '白泽：继续。' },
      expect.objectContaining({ type: 'done', provider: 'local_claude_code', reply: '白泽：继续。' })
    ]);
    expect(result).toMatchObject({ type: 'done', provider: 'local_claude_code', reply: '白泽：继续。' });
  });

  it('parses Jira client operations from structured replies', () => {
    const result = parseLocalClaudeCodeOutput(JSON.stringify({
      reply: '',
      clientOperations: [
        { id: 'jira-1', plugin: 'jira', action: 'search_issue', input: { projectKey: 'BUG', maxResults: 10 } },
        { id: 'jira-2', plugin: 'jira', action: 'create_issue', input: { drafts: [{ summary: '客户端需求', projectKey: 'BZ' }] } },
        { id: 'jira-3', plugin: 'jira', action: 'delete_issue', input: { key: 'BUG-1' } }
      ]
    }));

    expect(result.clientOperations).toEqual([
      { id: 'jira-1', plugin: 'jira', action: 'search_issue', input: { projectKey: 'BUG', maxResults: 10 } },
      { id: 'jira-2', plugin: 'jira', action: 'create_issue', input: { drafts: [{ summary: '客户端需求', projectKey: 'BZ' }] } }
    ]);
  });

  it('executes client operations and resumes Claude Code with results', async () => {
    const calls = [];
    const operations = [];
    const chat = createLocalClaudeCodeChat({
      runner: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            output: JSON.stringify({
              reply: '',
              clientOperations: [{ id: 'jira-1', plugin: 'jira', action: 'search_issue', input: { projectKey: 'BUG', maxResults: 10 } }]
            }),
            sessionId: 'session-1'
          };
        }
        return { output: '白泽：平均完成时间 2 天。', sessionId: 'session-1' };
      }
    });

    const result = await chat.send({ text: '最近10个BUG平均完成时间', conversationId: 'conversation-1' }, {
      executeClientOperation: async (operation) => {
        operations.push(operation);
        return { ok: true, plugin: 'jira', action: operation.action, result: { timingAnalysis: { averageCompletionDays: 2 } } };
      }
    });

    expect(operations).toEqual([{ id: 'jira-1', plugin: 'jira', action: 'search_issue', input: { projectKey: 'BUG', maxResults: 10 } }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].resumeSessionId).toBe('session-1');
    expect(calls[1].prompt).toContain('timingAnalysis');
    expect(result.reply).toBe('白泽：平均完成时间 2 天。');
  });

  it('allows Jira tool operations during confirmed execution mode', async () => {
    const calls = [];
    const operations = [];
    const chat = createLocalClaudeCodeChat({
      runner: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          return {
            output: JSON.stringify({
              reply: '',
              clientOperations: [{ id: 'jira-tool-1', plugin: 'jira', action: 'get_project', input: { projectKey: 'BZ' } }]
            }),
            sessionId: 'session-1'
          };
        }
        return { output: '白泽：Jira 项目已确认。', sessionId: 'session-1' };
      }
    });

    const result = await chat.send({ text: '执行已确认 Jira', conversationId: 'conversation-1', operation: { id: 'jira-op-1' } }, {
      mode: 'jira_confirmed_execution',
      executeClientOperation: async (operation) => {
        operations.push(operation);
        return { ok: true, plugin: 'jira', action: operation.action, result: { key: 'BZ' } };
      }
    });

    expect(calls[0].prompt).toContain('用户已经在客户端确认卡中点击“确认创建 Jira 单”');
    expect(calls[0].prompt).toContain('同一阶段不互相依赖的工具要尽量放在同一个 clientOperations 数组里一次输出');
    expect(calls[1].prompt).toContain('同一阶段不互相依赖的后续 Jira 工具要尽量合并到一个 clientOperations 数组里输出');
    expect(operations).toEqual([{ id: 'jira-tool-1', plugin: 'jira', action: 'get_project', input: { projectKey: 'BZ' } }]);
    expect(result.reply).toBe('白泽：Jira 项目已确认。');
  });

  it('carries Jira create operation results into the final local chat result', async () => {
    const operation = {
      id: 'jira-op-1',
      kind: 'jira_bulk_create',
      status: 'awaiting_confirmation',
      draftImport: { count: 1, drafts: [{ summary: '客户端需求', projectKey: 'BZ' }] }
    };
    const chat = createLocalClaudeCodeChat({
      runner: async (input) => {
        if (input.prompt.includes('用户消息')) {
          return {
            output: JSON.stringify({
              reply: '白泽：已生成 Jira 草稿，请确认创建。',
              clientOperations: [{ id: 'jira-create-1', plugin: 'jira', action: 'create_issue', input: { drafts: [{ summary: '客户端需求', projectKey: 'BZ' }] } }]
            }),
            sessionId: 'session-1'
          };
        }
        return { output: '白泽：已生成 Jira 创建确认卡，请在客户端确认。', sessionId: 'session-1' };
      }
    });

    const result = await chat.send({ text: '创建 Jira', conversationId: 'conversation-1' }, {
      executeClientOperation: async (clientOperation) => ({ ok: true, plugin: 'jira', action: clientOperation.action, id: clientOperation.id, operation })
    });

    expect(result.jiraOperation).toBe(operation);
    expect(result.results).toEqual([{ ok: true, plugin: 'jira', action: 'create_issue', id: 'jira-create-1', operation }]);
    expect(result.reply).toBe('白泽：已生成 Jira 创建确认卡，请在客户端确认。');
  });

  it('parses structured replies with allowed sync events', () => {
    const result = parseLocalClaudeCodeOutput(JSON.stringify({
      reply: '白泽：已记录逻辑断言。',
      syncEvents: [
        { type: 'logic_assertion.created', payload: { statement: '多人负责人一对一拆单。' } },
        { type: 'memory.created', payload: { category: 'project', content: '客户端本地处理请求。' } }
      ]
    }));

    expect(result).toEqual({
      reply: '白泽：已记录逻辑断言。',
      syncEvents: [
        { type: 'logic_assertion.created', payload: { statement: '多人负责人一对一拆单。' } },
        { type: 'memory.created', payload: { category: 'project', content: '客户端本地处理请求。' } }
      ],
      clientOperations: []
    });
  });

  it('keeps plain text replies without sync events', () => {
    const result = parseLocalClaudeCodeOutput('白泽：普通回复。');

    expect(result).toEqual({
      reply: '白泽：普通回复。',
      syncEvents: [],
      clientOperations: []
    });
  });

  it('filters sync events that should not be uploaded by local chat', () => {
    const result = parseLocalClaudeCodeOutput(JSON.stringify({
      reply: '白泽：普通分析完成。',
      syncEvents: [
        { type: 'audit.created', payload: { content: '普通分析审计。' } },
        { type: 'client_runtime.updated', payload: { enabled: false } },
        { type: 'plugin.operation_requested', payload: { pluginId: 'jira', action: 'create_issue' } },
        { type: 'unsupported.created', payload: { value: true } },
        { type: 'memory.updated', payload: { id: 'memory-1', content: '允许更新记忆。' } }
      ]
    }));

    expect(result).toEqual({
      reply: '白泽：普通分析完成。',
      syncEvents: [
        { type: 'memory.updated', payload: { id: 'memory-1', content: '允许更新记忆。' } }
      ],
      clientOperations: []
    });
  });

  it('tells local Claude Code to upload only memory and logic changes', () => {
    const prompt = buildLocalClaudeCodePrompt({
      text: '帮我分析一下这个需求',
      pluginPermissions: { enabled: true, plugins: [{ id: 'jira', permissions: { allowedActions: ['create_issue'] } }] }
    });

    expect(prompt).toContain('默认不要上报服务器');
    expect(prompt).toContain('普通聊天、普通问答、普通分析、只读文件分析都只返回中文文本，不要输出 syncEvents');
    expect(prompt).toContain('只有用户明确要求修改记忆或修改逻辑时，才输出 JSON 并带 syncEvents');
    expect(prompt).toContain('插件调用不需要上报服务器授权请求');
    expect(prompt).toContain('插件权限策略：');
    expect(prompt).not.toContain('plugin.operation_requested');
  });
});
