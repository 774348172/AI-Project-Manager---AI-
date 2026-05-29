const {
  normalizeServerUrl,
  getHealth,
  getClaudeConfig,
  getJiraConfig,
  getClientVersionStatus,
  getClientRuntimeStatus,
  getPluginUpdates,
  searchJiraIssues,
  sendChat,
  sendChatStream,
  listServerConversations,
  getServerConversation,
  createServerConversation,
  getClaudeCodeOperation,
  confirmClaudeCodeOperation,
  rejectClaudeCodeOperation,
  reportClaudeCodeApplicationResult,
  uploadAttachment,
  rememberAttachment,
  createJiraImportDrafts,
  getJiraOperation,
  confirmJiraOperation,
  updateJiraOperationDrafts,
  rejectJiraOperation,
  recoverJiraOperation,
  appendSyncEvent,
  listSyncEvents,
  getBugAnalysisRun,
  resumeBugAnalysisRun,
  confirmBugAnalysisComment,
  applyBugAnalysisRecovery
} = require('../client/desktop/baize-api.cjs');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('desktop Baize API wrapper', () => {
  it('normalizes server URLs', () => {
    expect(normalizeServerUrl('http://127.0.0.1:3000/path')).toBe('http://127.0.0.1:3000');
  });

  it('rejects invalid server URLs', () => {
    expect(() => normalizeServerUrl('not a url')).toThrow('请输入有效的白泽服务器地址');
    expect(() => normalizeServerUrl('file:///tmp/baize')).toThrow('请输入有效的白泽服务器地址');
  });

  it('requests health from the configured server', async () => {
    let calledUrl;
    const fetchImpl = async (url) => {
      calledUrl = url;
      return jsonResponse({ ok: true, service: 'baize-local-hub', phase: '1' });
    };

    const result = await getHealth('http://127.0.0.1:3000', { fetchImpl });

    expect(calledUrl).toBe('http://127.0.0.1:3000/health');
    expect(result.service).toBe('baize-local-hub');
  });

  it('requests public Claude config without sending a key', async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({
        ok: true,
        data: {
          provider: 'claude',
          apiKeyConfigured: true,
          baseURL: 'https://claude.example.test',
          model: 'claude-opus-4-7'
        }
      });
    };

    const result = await getClaudeConfig('http://127.0.0.1:3000', { fetchImpl });

    expect(request.url).toBe('http://127.0.0.1:3000/config/claude');
    expect(request.options.body).toBeUndefined();
    expect(result.apiKeyConfigured).toBe(true);
  });

  it('requests public Jira config without sending credentials', async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({
        ok: true,
        data: {
          enabled: true,
          baseURL: 'http://jira.test',
          credentialConfigured: false,
          fieldMappings: { taskOwner: 'customfield_10010' }
        }
      });
    };

    const result = await getJiraConfig('http://127.0.0.1:3000', { fetchImpl });

    expect(request.url).toBe('http://127.0.0.1:3000/config/jira');
    expect(request.options.body).toBeUndefined();
    expect(result.fieldMappings.taskOwner).toBe('customfield_10010');
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('apiToken');
  });

  it('requests client runtime and plugin control-plane status', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({
        ok: true,
        data: url.includes('/client/runtime')
          ? { enabled: true, localClaudeCode: { enabled: true } }
          : { enabled: true, plugins: [{ id: 'jira' }] }
      });
    };

    const runtime = await getClientRuntimeStatus('http://127.0.0.1:3000', { clientId: 'desktop-client-1' }, { fetchImpl });
    const plugins = await getPluginUpdates('http://127.0.0.1:3000', { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/client/runtime?platform=windows&clientId=desktop-client-1');
    expect(requests[1].url).toBe('http://127.0.0.1:3000/plugins/updates');
    expect(runtime.localClaudeCode.enabled).toBe(true);
    expect(plugins.plugins[0].id).toBe('jira');
  });

  it('requests client version status for forced updates', async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({
        ok: true,
        data: {
          enabled: true,
          currentVersion: '0.2.0',
          clientVersion: '0.1.0',
          updateAvailable: true,
          updateRequired: true,
          forceUpdate: true
        }
      });
    };

    const result = await getClientVersionStatus('http://127.0.0.1:3000', { version: '0.1.0' }, { fetchImpl });

    expect(request.url).toBe('http://127.0.0.1:3000/client/version?platform=windows&version=0.1.0');
    expect(request.options.body).toBeUndefined();
    expect(result.updateRequired).toBe(true);
  });

  it('searches Jira issues through the server plugin endpoint', async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({ ok: true, data: { issues: [], timingAnalysis: { totalIssues: 0 } } });
    };

    const result = await searchJiraIssues('http://127.0.0.1:3000', {
      clientOperation: true,
      jql: 'project = "BUG" ORDER BY resolutiondate DESC',
      maxResults: 10,
      includeCompletionTiming: true
    }, { fetchImpl });

    expect(request.url).toBe('http://127.0.0.1:3000/plugins/jira/search');
    expect(request.options.method).toBe('POST');
    expect(JSON.parse(request.options.body)).toEqual({
      clientOperation: true,
      jql: 'project = "BUG" ORDER BY resolutiondate DESC',
      maxResults: 10,
      includeCompletionTiming: true
    });
    expect(result.timingAnalysis.totalIssues).toBe(0);
  });

  it('sends desktop chat messages', async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({
        ok: true,
        data: {
          reply: '白泽：收到。',
          provider: 'local_kb',
          results: []
        }
      });
    };

    const result = await sendChat('http://127.0.0.1:3000', {
      text: '能量机制',
      userId: 'desktop-user',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1'
    }, { fetchImpl });

    expect(request.url).toBe('http://127.0.0.1:3000/chat');
    expect(request.options.method).toBe('POST');
    expect(JSON.parse(request.options.body)).toEqual({
      text: '能量机制',
      platform: 'desktop',
      userId: 'desktop-user',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1'
    });
    expect(result.reply).toBe('白泽：收到。');
  });

  it('streams desktop chat messages', async () => {
    const events = [];
    let request;
    const encoder = new TextEncoder();
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"meta","provider":"claude"}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"status","message":"正在分析"}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"permission_required","message":"需要确认"}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"delta","text":"白泽："}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"done","reply":"白泽：收到。","provider":"claude"}\n\n'));
            controller.close();
          }
        })
      };
    };

    const result = await sendChatStream('http://127.0.0.1:3000', {
      text: '能量机制',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1'
    }, {
      fetchImpl,
      onEvent: (event) => events.push(event)
    });

    expect(request.url).toBe('http://127.0.0.1:3000/chat/stream');
    expect(JSON.parse(request.options.body)).toEqual({
      text: '能量机制',
      platform: 'desktop',
      userId: 'desktop-user',
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1'
    });
    expect(events.map((event) => event.type)).toEqual(['meta', 'status', 'permission_required', 'delta', 'done']);
    expect(result.reply).toBe('白泽：收到。');
  });

  it('calls server conversation endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({
        ok: true,
        data: {
          conversations: [],
          conversation: { id: 'conversation-1' },
          messages: []
        }
      });
    };

    await listServerConversations('http://127.0.0.1:3000', { clientId: 'desktop-client-1' }, { fetchImpl });
    await getServerConversation('http://127.0.0.1:3000', 'conversation-1', { fetchImpl });
    await createServerConversation('http://127.0.0.1:3000', { id: 'conversation-1', clientId: 'desktop-client-1' }, { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/conversations?clientId=desktop-client-1');
    expect(requests[1].url).toBe('http://127.0.0.1:3000/conversations/conversation-1');
    expect(requests[2].url).toBe('http://127.0.0.1:3000/conversations');
    expect(JSON.parse(requests[2].options.body)).toMatchObject({
      id: 'conversation-1',
      clientId: 'desktop-client-1',
      platform: 'desktop'
    });
  });

  it('calls sync event endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, data: { event: { version: 1 }, events: [], lastVersion: 1 } });
    };

    await appendSyncEvent('http://127.0.0.1:3000', {
      type: 'logic_assertion.created',
      clientId: 'desktop-client-1',
      payload: { statement: '同步断言' }
    }, { fetchImpl });
    await listSyncEvents('http://127.0.0.1:3000', { since: 1, limit: 20 }, { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/sync/events');
    expect(requests[0].options.method).toBe('POST');
    expect(JSON.parse(requests[0].options.body)).toEqual({
      type: 'logic_assertion.created',
      clientId: 'desktop-client-1',
      payload: { statement: '同步断言' }
    });
    expect(requests[1].url).toBe('http://127.0.0.1:3000/sync/events?since=1&limit=20');
  });

  it('calls Claude Code operation endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, data: { operation: { id: 'op-1' } } });
    };

    await getClaudeCodeOperation('http://127.0.0.1:3000', 'op-1', { fetchImpl });
    await confirmClaudeCodeOperation('http://127.0.0.1:3000', 'op-1', { clientId: 'client-1' }, { fetchImpl });
    await rejectClaudeCodeOperation('http://127.0.0.1:3000', 'op-1', { clientId: 'client-1' }, { fetchImpl });
    await reportClaudeCodeApplicationResult('http://127.0.0.1:3000', 'op-1', { status: 'applied' }, { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/claude-code/operations/op-1');
    expect(requests[1].url).toBe('http://127.0.0.1:3000/claude-code/operations/op-1/confirm');
    expect(JSON.parse(requests[1].options.body)).toEqual({ clientId: 'client-1' });
    expect(requests[2].url).toBe('http://127.0.0.1:3000/claude-code/operations/op-1/reject');
    expect(requests[3].url).toBe('http://127.0.0.1:3000/claude-code/operations/op-1/application-result');
  });

  it('calls Jira import and operation endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, data: { operation: { id: 'jira-op-1' }, drafts: [] } });
    };

    await createJiraImportDrafts('http://127.0.0.1:3000', { attachmentId: 'att-1', clientId: 'client-1' }, { fetchImpl });
    await getJiraOperation('http://127.0.0.1:3000', 'jira-op-1', { fetchImpl });
    await confirmJiraOperation('http://127.0.0.1:3000', 'jira-op-1', { clientId: 'client-1' }, { fetchImpl });
    await updateJiraOperationDrafts('http://127.0.0.1:3000', 'jira-op-1', { clientId: 'client-1', projectKey: 'BATTLE' }, { fetchImpl });
    await rejectJiraOperation('http://127.0.0.1:3000', 'jira-op-1', { clientId: 'client-1' }, { fetchImpl });
    await recoverJiraOperation('http://127.0.0.1:3000', 'jira-op-1', { clientId: 'client-1', actionId: 'retry_without_labels' }, { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/plugins/jira/import-drafts');
    expect(JSON.parse(requests[0].options.body)).toEqual({ attachmentId: 'att-1', clientId: 'client-1' });
    expect(requests[1].url).toBe('http://127.0.0.1:3000/plugins/jira/operations/jira-op-1');
    expect(requests[2].url).toBe('http://127.0.0.1:3000/plugins/jira/operations/jira-op-1/confirm');
    expect(requests[3].url).toBe('http://127.0.0.1:3000/plugins/jira/operations/jira-op-1/drafts');
    expect(JSON.parse(requests[3].options.body)).toEqual({ clientId: 'client-1', projectKey: 'BATTLE' });
    expect(requests[4].url).toBe('http://127.0.0.1:3000/plugins/jira/operations/jira-op-1/reject');
    expect(requests[5].url).toBe('http://127.0.0.1:3000/plugins/jira/operations/jira-op-1/recovery');
    expect(JSON.parse(requests[5].options.body)).toEqual({ clientId: 'client-1', actionId: 'retry_without_labels' });
  });

  it('calls Jira Bug analysis endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, data: { run: { id: 'bug-run-1' } } });
    };

    await getBugAnalysisRun('http://127.0.0.1:3000', 'bug-run-1', { fetchImpl });
    await resumeBugAnalysisRun('http://127.0.0.1:3000', 'bug-run-1', { clientId: 'client-1' }, { fetchImpl });
    await confirmBugAnalysisComment('http://127.0.0.1:3000', 'bug-run-1', 'bug-item-1', { clientId: 'client-1' }, { fetchImpl });
    await applyBugAnalysisRecovery('http://127.0.0.1:3000', 'bug-run-1', 'bug-item-1', { actionId: 'retry_analysis' }, { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/plugins/jira/bug-analysis/runs/bug-run-1');
    expect(requests[1].url).toBe('http://127.0.0.1:3000/plugins/jira/bug-analysis/runs/bug-run-1/resume');
    expect(JSON.parse(requests[1].options.body)).toEqual({ clientId: 'client-1' });
    expect(requests[2].url).toBe('http://127.0.0.1:3000/plugins/jira/bug-analysis/runs/bug-run-1/items/bug-item-1/comment/confirm');
    expect(requests[3].url).toBe('http://127.0.0.1:3000/plugins/jira/bug-analysis/runs/bug-run-1/items/bug-item-1/recovery');
    expect(JSON.parse(requests[3].options.body)).toEqual({ actionId: 'retry_analysis' });
  });

  it('calls attachment upload and memory endpoints', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, data: { attachment: { id: 'att-1' } } });
    };

    await uploadAttachment('http://127.0.0.1:3000', {
      fileName: 'notes.txt',
      contentBase64: Buffer.from('hello').toString('base64')
    }, { fetchImpl });
    await rememberAttachment('http://127.0.0.1:3000', 'att-1', {
      category: 'project',
      localPath: 'D:/secret/a.png',
      filePath: 'D:/secret/file.png',
      token: 'secret-token',
      clientAnalysis: {
        provider: 'local_claude_code',
        summary: '图片摘要',
        memoryCategory: 'project',
        shouldRemember: true,
        reason: '应记忆',
        extractedText: 'OCR',
        localPath: 'D:/secret/a.png',
        apiKey: 'secret-api-key'
      }
    }, { fetchImpl });

    expect(requests[0].url).toBe('http://127.0.0.1:3000/attachments/upload');
    expect(requests[0].options.method).toBe('POST');
    expect(JSON.parse(requests[0].options.body).fileName).toBe('notes.txt');
    expect(requests[1].url).toBe('http://127.0.0.1:3000/attachments/att-1/remember');
    expect(JSON.parse(requests[1].options.body)).toEqual({
      category: 'project',
      clientAnalysis: {
        provider: 'local_claude_code',
        summary: '图片摘要',
        memoryCategory: 'project',
        shouldRemember: true,
        reason: '应记忆',
        extractedText: 'OCR'
      }
    });
    expect(requests[1].options.body).not.toContain('D:/secret');
    expect(requests[1].options.body).not.toContain('secret-token');
    expect(requests[1].options.body).not.toContain('secret-api-key');
  });

  it('surfaces cancelled stream requests', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const fetchImpl = async () => {
      throw abortError;
    };

    await expect(sendChatStream('http://127.0.0.1:3000', { text: '你好' }, { fetchImpl })).rejects.toMatchObject({
      code: 'BAIZE_REQUEST_CANCELLED',
      message: '已取消本次回答。'
    });
  });

  it('surfaces server API errors', async () => {
    const fetchImpl = async () => jsonResponse({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'text is required.'
      }
    }, { status: 400 });

    await expect(sendChat('http://127.0.0.1:3000', { text: '' }, { fetchImpl })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: '请输入要发送的内容。',
      status: 400
    });
  });
});
