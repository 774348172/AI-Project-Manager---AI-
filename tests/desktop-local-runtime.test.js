const { createLocalRuntime } = require('../client/desktop/local-runtime.cjs');

describe('desktop local runtime', () => {
  it('sends chat through local Claude Code with plugin permissions when enabled by runtime config', async () => {
    let localInput;
    let serverCalled = false;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        send: async (input) => {
          localInput = input;
          return { provider: 'local_claude_code', reply: '白泽：本机回复。' };
        }
      },
      chatTransport: {
        getPluginUpdates: async () => ({
          enabled: true,
          plugins: [{ id: 'jira', permissions: { allowedActions: ['create_issue'] } }]
        }),
        sendChat: async () => {
          serverCalled = true;
          return { provider: 'server', reply: 'server' };
        }
      }
    });

    const result = await runtime.handleChat({ text: '你好', conversationId: 'conversation-1' });

    expect(localInput).toEqual({
      text: '你好',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1',
      pluginPermissions: {
        enabled: true,
        plugins: [{ id: 'jira', permissions: { allowedActions: ['create_issue'] } }]
      }
    });
    expect(serverCalled).toBe(false);
    expect(result).toEqual({ provider: 'local_claude_code', reply: '白泽：本机回复。' });
  });

  it('passes server Claude Code env to local Claude Code options without putting it in chat input', async () => {
    let localInput;
    let localOptions;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({
        enabled: true,
        localClaudeCode: {
          enabled: true,
          env: {
            ANTHROPIC_AUTH_TOKEN: 'server-token',
            ANTHROPIC_BASE_URL: 'http://claude.example.test',
            EMPTY_VALUE: ''
          }
        }
      }),
      localClaudeCode: {
        send: async (input, options = {}) => {
          localInput = input;
          localOptions = options;
          return { provider: 'local_claude_code', reply: '白泽：本机回复。' };
        }
      }
    });

    await runtime.handleChat({ text: '你好', conversationId: 'conversation-1' });

    expect(localOptions.localClaudeCodeEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'server-token',
      ANTHROPIC_BASE_URL: 'http://claude.example.test'
    });
    expect(JSON.stringify(localInput)).not.toContain('server-token');
    expect(JSON.stringify(localInput)).not.toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('analyzes images through local Claude Code with server env', async () => {
    let analyzedInput;
    let analyzedOptions;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({
        enabled: true,
        localClaudeCode: {
          enabled: true,
          env: { ANTHROPIC_AUTH_TOKEN: 'server-token', EMPTY_VALUE: '' }
        }
      }),
      localClaudeCode: {
        send: async () => ({ provider: 'local_claude_code', reply: '白泽：本机回复。' })
      },
      imageAnalyzer: async (input, options) => {
        analyzedInput = input;
        analyzedOptions = options;
        return { provider: 'local_claude_code', summary: '图片摘要', memoryCategory: 'project', shouldRemember: true, reason: '有上下文', extractedText: '' };
      }
    });

    const result = await runtime.analyzeImageAttachment({ fileName: 'a.png', localPath: 'D:/tmp/a.png' });

    expect(result.summary).toBe('图片摘要');
    expect(analyzedInput).toEqual({ fileName: 'a.png', localPath: 'D:/tmp/a.png' });
    expect(analyzedOptions.localClaudeCodeEnv).toEqual({ ANTHROPIC_AUTH_TOKEN: 'server-token' });
  });

  it('analyzes pending images before remembering them', async () => {
    let analyzedInput;
    let rememberRequest;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true, localClaudeCode: { enabled: true, env: { ANTHROPIC_AUTH_TOKEN: 'server-token' } } }),
      localClaudeCode: {
        send: async () => ({ provider: 'local_claude_code', reply: '白泽：本机回复。' })
      },
      imageAnalyzer: async (input) => {
        analyzedInput = input;
        return { provider: 'local_claude_code', summary: '记忆时图片摘要', memoryCategory: 'project', shouldRemember: true, reason: '应记忆', extractedText: 'OCR', localPath: 'D:/secret/a.png', token: 'secret-token' };
      },
      chatTransport: {
        rememberAttachment: async (serverUrl, attachmentId, input) => {
          rememberRequest = { serverUrl, attachmentId, input };
          return { attachment: { id: attachmentId, memory: { status: 'remembered' } } };
        }
      }
    });

    const result = await runtime.rememberAttachment('att-1', {
      type: 'image',
      fileName: 'a.png',
      mimeType: 'image/png',
      size: 100,
      localPath: 'D:/tmp/a.png',
      clientAnalysis: { provider: 'local_claude_code_pending', summary: '图片已保存；如需视觉分析', reason: 'pending' }
    });

    expect(analyzedInput).toEqual({ fileName: 'a.png', mimeType: 'image/png', size: 100, localPath: 'D:/tmp/a.png' });
    expect(rememberRequest).toEqual({
      serverUrl: 'http://baize.test',
      attachmentId: 'att-1',
      input: {
        category: undefined,
        clientAnalysis: { provider: 'local_claude_code', summary: '记忆时图片摘要', memoryCategory: 'project', shouldRemember: true, reason: '应记忆', extractedText: 'OCR' }
      }
    });
    expect(JSON.stringify(rememberRequest.input)).not.toContain('D:/secret');
    expect(JSON.stringify(rememberRequest.input)).not.toContain('secret-token');
    expect(result.attachment.memory.status).toBe('remembered');
  });

  it('reanalyzes images when remembering even if an old analysis exists', async () => {
    let analyzedInput;
    let rememberRequest;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true, localClaudeCode: { enabled: true } }),
      imageAnalyzer: async (input) => {
        analyzedInput = input;
        return { provider: 'local_claude_code', summary: '重新分析摘要', memoryCategory: 'project', shouldRemember: true, reason: '重新分析', extractedText: '' };
      },
      chatTransport: {
        rememberAttachment: async (serverUrl, attachmentId, input) => {
          rememberRequest = { serverUrl, attachmentId, input };
          return { attachment: { id: attachmentId } };
        }
      }
    });

    await runtime.rememberAttachment('att-1', {
      type: 'image',
      fileName: 'a.png',
      localPath: 'D:/tmp/a.png',
      clientAnalysis: { provider: 'local_claude_code', summary: '已有摘要', memoryCategory: 'project', shouldRemember: true, reason: '已有分析', extractedText: '' }
    });

    expect(analyzedInput.localPath).toBe('D:/tmp/a.png');
    expect(rememberRequest.input.clientAnalysis.summary).toBe('重新分析摘要');
  });

  it('does not call server remember when pending image lacks local path', async () => {
    let serverCalled = false;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true, localClaudeCode: { enabled: true } }),
      chatTransport: {
        rememberAttachment: async () => {
          serverCalled = true;
          return {};
        }
      }
    });

    await expect(runtime.rememberAttachment('att-1', {
      type: 'image',
      fileName: 'a.png',
      clientAnalysis: { provider: 'local_claude_code_pending', summary: '图片已保存；如需视觉分析' }
    })).rejects.toMatchObject({
      code: 'LOCAL_IMAGE_PATH_REQUIRED',
      message: '图片加入记忆区前必须完成本机 Claude Code 视觉分析，但客户端没有保留本机图片路径。请重新拖入或粘贴图片后再试。'
    });
    expect(serverCalled).toBe(false);
  });

  it('does not call server remember when local Claude Code is disabled for pending images', async () => {
    let serverCalled = false;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: false }),
      chatTransport: {
        rememberAttachment: async () => {
          serverCalled = true;
          return {};
        }
      }
    });

    await expect(runtime.rememberAttachment('att-1', {
      type: 'image',
      fileName: 'a.png',
      localPath: 'D:/tmp/a.png',
      clientAnalysis: { provider: 'local_claude_code_pending', summary: '图片已保存；如需视觉分析' }
    })).rejects.toMatchObject({
      code: 'LOCAL_CLAUDE_CODE_DISABLED',
      message: '本机 Claude Code 未启用，无法分析图片。'
    });
    expect(serverCalled).toBe(false);
  });

  it('passes local attachment paths to local Claude Code', async () => {
    let localInput;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        send: async (input) => {
          localInput = input;
          return { provider: 'local_claude_code', reply: '白泽：本机回复。' };
        }
      }
    });

    await runtime.handleChat({
      text: '读取附件',
      conversationId: 'conversation-1',
      attachmentIds: ['att-1'],
      localAttachments: [{ id: 'att-1', name: '需求.xlsx', source: 'file', localPath: 'D:/tmp/需求.xlsx' }]
    });

    expect(localInput.localAttachments).toEqual([
      { id: 'att-1', name: '需求.xlsx', source: 'file', localPath: 'D:/tmp/需求.xlsx' }
    ]);
  });

  it('syncs allowed local Claude Code events to the server', async () => {
    const syncRequests = [];
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        send: async () => ({
          provider: 'local_claude_code',
          reply: '白泽：已记录逻辑断言。',
          syncEvents: [
            { type: 'logic_assertion.created', payload: { statement: '多人负责人一对一拆单。' } },
            { type: 'memory.updated', payload: { id: 'memory-1', content: '客户端本地处理请求。' } }
          ]
        })
      },
      chatTransport: {
        appendSyncEvent: async (serverUrl, input) => {
          syncRequests.push({ serverUrl, input });
          return { event: { version: syncRequests.length, ...input } };
        }
      }
    });

    const result = await runtime.handleChat({ text: '记录逻辑', userId: 'desktop-user', conversationId: 'conversation-1' });

    expect(syncRequests).toEqual([
      {
        serverUrl: 'http://baize.test',
        input: expect.objectContaining({
          type: 'logic_assertion.created',
          clientId: 'desktop-client-1',
          userId: 'desktop-user',
          payload: { statement: '多人负责人一对一拆单。' }
        })
      },
      {
        serverUrl: 'http://baize.test',
        input: expect.objectContaining({
          type: 'memory.updated',
          clientId: 'desktop-client-1',
          userId: 'desktop-user',
          payload: { id: 'memory-1', content: '客户端本地处理请求。' }
        })
      }
    ]);
    expect(result.syncedEvents).toEqual([
      expect.objectContaining({ version: 1, type: 'logic_assertion.created' }),
      expect.objectContaining({ version: 2, type: 'memory.updated' })
    ]);
  });

  it('executes allowed Jira client operations from local Claude Code', async () => {
    let operationResult;
    let jiraRequest;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        send: async (input, options = {}) => {
          operationResult = await options.executeClientOperation({ id: 'jira-1', plugin: 'jira', action: 'search_issue', input: { projectKey: 'BUG', maxResults: 10 } });
          return { provider: 'local_claude_code', reply: '白泽：完成。' };
        }
      },
      chatTransport: {
        getPluginUpdates: async () => ({
          enabled: true,
          plugins: [{ id: 'jira', enabled: true, permissions: { allowLocalDecision: true, allowedActions: ['search_issue'], deniedActions: [] } }]
        }),
        searchJiraIssues: async (serverUrl, input) => {
          jiraRequest = { serverUrl, input };
          return { timingAnalysis: { averageCompletionDays: 2 } };
        }
      }
    });

    await runtime.handleChat({ text: '实时查询', userId: 'desktop-user', conversationId: 'conversation-1' });

    expect(jiraRequest).toEqual({
      serverUrl: 'http://baize.test',
      input: {
        projectKey: 'BUG',
        maxResults: 10,
        clientOperation: true,
        disableRecovery: true,
        clientId: 'desktop-client-1',
        userId: 'desktop-user',
        conversationId: 'conversation-1'
      }
    });
    expect(operationResult).toEqual({ ok: true, plugin: 'jira', action: 'search_issue', id: 'jira-1', result: { timingAnalysis: { averageCompletionDays: 2 } } });
  });

  it('creates a local Jira confirmation card from local Claude Code create operations', async () => {
    const events = [];
    let jiraRequest;
    let serverImportCalled = false;
    let operationResult;
    const operation = {
      id: 'jira-op-1',
      kind: 'jira_bulk_create',
      status: 'awaiting_confirmation',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1',
      draftImport: { count: 1, drafts: [{ summary: '客户端需求', projectKey: 'BZ' }] }
    };
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      jiraService: {
        createJiraImportDraftsWithOperation: async (input) => {
          jiraRequest = input;
          return { count: 1, drafts: input.drafts, operation };
        }
      },
      localClaudeCode: {
        sendStream: async (input, options = {}) => {
          operationResult = await options.executeClientOperation({
            id: 'jira-create-1',
            plugin: 'jira',
            action: 'create_issue',
            input: { drafts: [{ summary: '客户端需求', projectKey: 'BZ', issueType: 'Task' }] }
          });
          options.onEvent({ type: 'done', provider: 'local_claude_code', reply: '白泽：请确认创建。', jiraOperation: operationResult.operation });
          return { type: 'done', provider: 'local_claude_code', reply: '白泽：请确认创建。', jiraOperation: operationResult.operation };
        }
      },
      chatTransport: {
        getPluginUpdates: async () => ({
          enabled: true,
          plugins: [{ id: 'jira', enabled: true, permissions: { allowLocalDecision: true, allowedActions: ['create_issue'], deniedActions: [] } }]
        }),
        createJiraImportDrafts: async () => {
          serverImportCalled = true;
          return {};
        }
      }
    });

    const result = await runtime.handleChatStream({ text: '创建 Jira', userId: 'desktop-user', conversationId: 'conversation-1' }, {
      onEvent: (event) => events.push(event)
    });

    expect(jiraRequest).toEqual({
      fileName: 'local-claude-code-jira-intent.json',
      drafts: [{ summary: '客户端需求', projectKey: 'BZ', issueType: 'Task' }],
      warnings: [],
      clientId: 'desktop-client-1',
      userId: 'desktop-user',
      conversationId: 'conversation-1'
    });
    expect(serverImportCalled).toBe(false);
    expect(operationResult).toEqual({ ok: true, plugin: 'jira', action: 'create_issue', id: 'jira-create-1', result: { count: 1, drafts: [{ summary: '客户端需求', projectKey: 'BZ', issueType: 'Task' }], operation }, operation });
    expect(events).toContainEqual({ type: 'jira_operation_required', message: '白泽：已生成 Jira 创建确认卡，请确认是否创建。', operation });
    expect(result.jiraOperation).toBe(operation);
  });

  it('runs confirmed Jira operations through local Claude Code tools', async () => {
    const executedOperations = [];
    const events = [];
    const confirmedOperation = {
      id: 'jira-op-1',
      kind: 'jira_bulk_create',
      status: 'confirmed_running',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1',
      draftImport: { count: 1, drafts: [{ summary: '客户端需求', projectKey: 'BZ', issueType: 'Task' }] },
      createdIssues: []
    };
    const createdOperation = {
      ...confirmedOperation,
      status: 'created',
      createdIssues: [{ id: '10001', key: 'BZ-1', summary: '客户端需求' }]
    };
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true, localClaudeCode: { enabled: true } }),
      jiraService: {
        confirmJiraOperation: async (operationId, input) => {
          expect(operationId).toBe('jira-op-1');
          expect(input.clientId).toBe('desktop-client-1');
          return confirmedOperation;
        },
        getJiraProject: async (input) => ({ key: input.projectKey, id: '10000', issueTypes: [{ id: '10001', name: 'Task' }] }),
        createConfirmedJiraIssue: async (operationId, input) => {
          expect(operationId).toBe('jira-op-1');
          expect(input.draftIndex).toBe(0);
          return { createdIssue: createdOperation.createdIssues[0], operation: createdOperation };
        },
        getJiraOperation: async () => createdOperation
      },
      localClaudeCode: {
        send: async (input, options = {}) => {
          expect(options.mode).toBe('jira_confirmed_execution');
          expect(input.operation).toBe(confirmedOperation);
          executedOperations.push(await options.executeClientOperation({ id: 'tool-1', plugin: 'jira', action: 'get_project', input: { projectKey: 'BZ' } }));
          executedOperations.push(await options.executeClientOperation({ id: 'tool-2', plugin: 'jira', action: 'create_confirmed_issue', input: { draftIndex: 0 } }));
          return { provider: 'local_claude_code', reply: '白泽：已创建 BZ-1。', results: executedOperations };
        }
      },
      chatTransport: {
        getPluginUpdates: async () => ({ enabled: true, plugins: [] })
      }
    });

    const result = await runtime.confirmJiraOperation('jira-op-1', { conversationId: 'conversation-1', clientId: 'desktop-client-1' }, { onEvent: (event) => events.push(event) });

    expect(executedOperations[0]).toEqual({ ok: true, plugin: 'jira', action: 'get_project', id: 'tool-1', result: { key: 'BZ', id: '10000', issueTypes: [{ id: '10001', name: 'Task' }] } });
    expect(executedOperations[1]).toEqual({ ok: true, plugin: 'jira', action: 'create_confirmed_issue', id: 'tool-2', result: { createdIssue: createdOperation.createdIssues[0], operation: createdOperation }, operation: createdOperation });
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', message: '已确认 Jira 创建，正在启动本机 Claude Code 执行 Jira 插件。' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', message: '正在校验 Jira 项目 BZ。', action: 'get_project' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', message: '已创建 Jira 单 BZ-1。', action: 'create_confirmed_issue' }));
    expect(events).toContainEqual({ type: 'jira_operation_created', operation: createdOperation });
    expect(result.operation).toBe(createdOperation);
    expect(result.reply).toBe('白泽：已创建 BZ-1。');
  });

  it('allows Jira client operations even when synced permission lists are empty', async () => {
    let operationResult;
    let serverCalled = false;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        send: async (input, options = {}) => {
          operationResult = await options.executeClientOperation({ id: 'jira-1', plugin: 'jira', action: 'search_issue', input: { projectKey: 'BUG' } });
          return { provider: 'local_claude_code', reply: '白泽：已查询。' };
        }
      },
      chatTransport: {
        getPluginUpdates: async () => ({ enabled: true, plugins: [{ id: 'jira', enabled: true, permissions: { allowLocalDecision: true, allowedActions: [], deniedActions: [] } }] }),
        searchJiraIssues: async () => {
          serverCalled = true;
          return { issues: [] };
        }
      }
    });

    await runtime.handleChat({ text: '实时查询', conversationId: 'conversation-1' });

    expect(operationResult).toEqual({ ok: true, plugin: 'jira', action: 'search_issue', id: 'jira-1', result: { issues: [] } });
    expect(serverCalled).toBe(true);
  });

  it('does not sync local Claude Code events that are not uploadable', async () => {
    const syncRequests = [];
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        send: async () => ({
          provider: 'local_claude_code',
          reply: '白泽：普通分析完成。',
          syncEvents: [
            { type: 'audit.created', payload: { content: '普通分析审计。' } },
            { type: 'client_runtime.updated', payload: { enabled: false } },
            { type: 'plugin.operation_requested', payload: { pluginId: 'jira', action: 'create_issue' } },
            { type: 'unsupported.created', payload: { value: true } }
          ]
        })
      },
      chatTransport: {
        appendSyncEvent: async (serverUrl, input) => {
          syncRequests.push({ serverUrl, input });
          return { event: { version: 1, ...input } };
        }
      }
    });

    const result = await runtime.handleChat({ text: '普通分析', conversationId: 'conversation-1' });

    expect(syncRequests).toEqual([]);
    expect(result.syncedEvents).toBeUndefined();
  });

  it('sends chat through the server fallback when local Claude Code is disabled', async () => {
    let request;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      chatTransport: {
        sendChat: async (serverUrl, input) => {
          request = { serverUrl, input };
          return { provider: 'local_runtime', reply: '白泽：本地运行时回复。' };
        }
      }
    });

    const result = await runtime.handleChat({
      text: '你好',
      conversationId: 'conversation-1',
      attachmentIds: ['att-1'],
      localAttachments: [{ id: 'att-1', name: 'secret.xlsx', localPath: 'D:/secret/secret.xlsx' }],
      localPath: 'D:/secret/top-level.txt',
      filePath: 'D:/secret/file-path.txt'
    });

    expect(request).toEqual({
      serverUrl: 'http://baize.test',
      input: {
        text: '你好',
        conversationId: 'conversation-1',
        attachmentIds: ['att-1'],
        clientId: 'desktop-client-1'
      }
    });
    expect(request.input.localAttachments).toBeUndefined();
    expect(request.input.localPath).toBeUndefined();
    expect(request.input.filePath).toBeUndefined();
    expect(result.reply).toBe('白泽：本地运行时回复。');
  });

  it('streams chat events through local Claude Code when enabled by runtime config', async () => {
    const events = [];
    let localRequest;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        sendStream: async (input, options = {}) => {
          localRequest = { input, hasSignal: Boolean(options.signal) };
          options.onEvent({ type: 'status', message: '白泽正在调用本机 Claude Code。' });
          options.onEvent({ type: 'delta', text: '白泽：' });
          options.onEvent({ type: 'done', provider: 'local_claude_code', reply: '白泽：完成。' });
          return { type: 'done', provider: 'local_claude_code', reply: '白泽：完成。' };
        }
      }
    });
    const controller = new AbortController();

    const result = await runtime.handleChatStream({ text: '流式' }, {
      signal: controller.signal,
      onEvent: (event) => events.push(event)
    });

    expect(localRequest).toEqual({
      input: { text: '流式', clientId: 'desktop-client-1', pluginPermissions: { enabled: false, plugins: [] } },
      hasSignal: true
    });
    expect(events).toEqual([
      { type: 'status', message: '白泽正在调用本机 Claude Code。' },
      { type: 'delta', text: '白泽：' },
      { type: 'done', provider: 'local_claude_code', reply: '白泽：完成。' }
    ]);
    expect(result).toMatchObject({ provider: 'local_claude_code', reply: '白泽：完成。' });
  });

  it('streams chat events through the server fallback when local Claude Code is disabled', async () => {
    const events = [];
    let request;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: false }),
      chatTransport: {
        sendChatStream: async (serverUrl, input, options = {}) => {
          request = { serverUrl, input, hasSignal: Boolean(options.signal) };
          options.onEvent({ type: 'delta', text: '白泽：' });
          options.onEvent({ type: 'done', reply: '白泽：完成。' });
          return { type: 'done', reply: '白泽：完成。' };
        }
      }
    });
    const controller = new AbortController();

    const result = await runtime.handleChatStream({
      text: '流式',
      attachmentIds: ['att-1'],
      localAttachments: [{ id: 'att-1', name: 'secret.xlsx', localPath: 'D:/secret/secret.xlsx' }],
      localPath: 'D:/secret/top-level.txt',
      filePath: 'D:/secret/file-path.txt'
    }, {
      signal: controller.signal,
      onEvent: (event) => events.push(event)
    });

    expect(request).toEqual({
      serverUrl: 'http://baize.test',
      input: { text: '流式', attachmentIds: ['att-1'], clientId: 'desktop-client-1' },
      hasSignal: true
    });
    expect(request.input.localAttachments).toBeUndefined();
    expect(request.input.localPath).toBeUndefined();
    expect(request.input.filePath).toBeUndefined();
    expect(events).toEqual([
      { type: 'delta', text: '白泽：' },
      { type: 'done', reply: '白泽：完成。' }
    ]);
    expect(result.reply).toBe('白泽：完成。');
  });

  it('pulls control-plane status and sync events from the server', async () => {
    const requests = [];
    const appliedSync = [];
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      syncStore: {
        getState: async () => ({ lastVersion: 0 }),
        applyEvents: async (events, options) => appliedSync.push({ events, options })
      },
      chatTransport: {
        getClientRuntimeStatus: async (serverUrl, input) => {
          requests.push({ kind: 'runtime', serverUrl, input });
          return {
            enabled: true,
            localClaudeCode: { enabled: true, env: { ANTHROPIC_AUTH_TOKEN: 'server-token' } },
            jira: { enabled: true, username: 'jira-user', password: 'jira-secret', apiToken: 'jira-token' }
          };
        },
        getPluginUpdates: async (serverUrl) => {
          requests.push({ kind: 'plugins', serverUrl });
          return { enabled: true, plugins: [{ id: 'jira' }] };
        },
        listSyncEvents: async (serverUrl, input) => {
          requests.push({ kind: 'sync', serverUrl, input });
          return { lastVersion: 2, events: [{ version: 2, type: 'memory.created' }] };
        }
      }
    });

    const controlPlane = await runtime.getControlPlaneStatus();
    const sync = await runtime.pullSyncEvents({ since: 1, limit: 50 });

    expect(controlPlane).toEqual({
      clientId: 'desktop-client-1',
      runtime: {
        enabled: true,
        localClaudeCode: { enabled: true, envConfigured: true },
        jira: { enabled: true, username: 'jira-user', credentialConfigured: true }
      },
      plugins: { enabled: true, plugins: [{ id: 'jira' }] }
    });
    expect(sync).toEqual({ lastVersion: 2, events: [{ version: 2, type: 'memory.created' }] });
    expect(appliedSync).toEqual([
      { events: [{ version: 2, type: 'memory.created' }], options: { lastVersion: 2 } }
    ]);
    expect(requests).toEqual(expect.arrayContaining([
      { kind: 'runtime', serverUrl: 'http://baize.test', input: { clientId: 'desktop-client-1', platform: 'windows' } },
      { kind: 'plugins', serverUrl: 'http://baize.test' },
      { kind: 'sync', serverUrl: 'http://baize.test', input: { since: 1, limit: 50 } }
    ]));
  });

  it('does not fall back to server stream when local Claude Code fails', async () => {
    let serverCalled = false;
    const runtime = createLocalRuntime({
      getServerUrl: async () => 'http://baize.test',
      getClientId: async () => 'desktop-client-1',
      getRuntimeConfig: async () => ({ enabled: true }),
      localClaudeCode: {
        sendStream: async () => {
          const error = new Error('本机 Claude Code 处理失败：local failed');
          error.code = 'LOCAL_CLAUDE_CODE_FAILED';
          throw error;
        }
      },
      chatTransport: {
        sendChatStream: async () => {
          serverCalled = true;
          return { type: 'done', provider: 'claude_code', reply: '服务器回复' };
        }
      }
    });

    await expect(runtime.handleChatStream({ text: '不要兜底' }, { onEvent: () => {} })).rejects.toMatchObject({
      code: 'LOCAL_CLAUDE_CODE_FAILED',
      message: '本机 Claude Code 处理失败：local failed'
    });
    expect(serverCalled).toBe(false);
  });
});
