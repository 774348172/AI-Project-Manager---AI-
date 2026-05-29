const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const { buildJql, analyzeIssues, searchAndAnalyzeJira } = require('../src/services/jira-search-service');
const { requestJira } = require('../src/services/jira-client-service');
const { createJiraImportDrafts } = require('../src/services/jira-import-service');
const { uploadAttachment } = require('../src/services/attachment-service');
const { createJiraCreateOperation, confirmJiraOperation, getJiraOperation, markJiraOperationProjectRequired, attachJiraOperationRecovery, applyJiraOperationRecovery } = require('../src/services/jira-operation-service');

async function writeJiraConfig(baizeRoot) {
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
    'enabled: true',
    'baseURL: http://127.0.0.1:8080',
    'deploymentType: server',
    'apiVersion: "2"',
    'authType: basic',
    'username: jira-user',
    'password: jira-password',
    'defaults:',
    '  projectKey: BZ',
    '  issueType: Story'
  ].join('\n'), 'utf8');
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('Jira plugin services', () => {
  it('builds dynamic JQL from filters', () => {
    expect(buildJql({ assignee: '张三', status: '进行中', labels: ['客户端'], updatedAfter: '2026-05-01' }, { projectKey: 'BZ' }))
      .toBe('project = "BZ" AND assignee = "张三" AND status = "进行中" AND labels = "客户端" AND updated >= "2026-05-01" ORDER BY updated DESC');
  });

  it('analyzes Jira issue status in Chinese summary', () => {
    const analysis = analyzeIssues([
      { key: 'BZ-1', status: 'Done', assignee: '张三' },
      { key: 'BZ-2', status: 'Blocked', assignee: '李四' }
    ]);

    expect(analysis.total).toBe(2);
    expect(analysis.completionRate).toBe(50);
    expect(analysis.blockedKeys).toEqual(['BZ-2']);
    expect(analysis.summary).toContain('共找到 2 个需求单');
  });

  it('searches Jira issues through configured server credentials', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([]);
      }
      return jsonResponse({
        total: 1,
        issues: [{
          id: '10001',
          key: 'BZ-1',
          fields: {
            summary: '客户端上传支持',
            status: { name: '进行中' },
            assignee: { displayName: '张三' },
            issuetype: { name: 'Story' },
            project: { key: 'BZ' }
          }
        }]
      });
    };

    const result = await searchAndAnalyzeJira({ assignee: '张三' }, { baizeRoot, fetchImpl });

    expect(request.url).toBe('http://127.0.0.1:8080/rest/api/2/search');
    expect(request.options.headers.Authorization).toMatch(/^Basic /);
    expect(JSON.parse(request.options.body).jql).toContain('assignee = "张三"');
    expect(result.issues[0]).toMatchObject({ key: 'BZ-1', summary: '客户端上传支持', status: '进行中' });
  });

  it('returns completion timing analysis for client Jira searches', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    let searchBody;
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([]);
      }
      searchBody = JSON.parse(options.body);
      return jsonResponse({
        total: 2,
        issues: [
          {
            id: '10001',
            key: 'BUG-1',
            fields: {
              summary: '已解决问题',
              status: { name: '已解决', statusCategory: { name: 'Done', key: 'done' } },
              assignee: { displayName: '张三' },
              issuetype: { name: 'Bug' },
              project: { key: 'BUG' },
              created: '2026-05-01T00:00:00.000+0800',
              updated: '2026-05-03T00:00:00.000+0800',
              resolutiondate: '2026-05-02T00:00:00.000+0800',
              statuscategorychangedate: '2026-05-02T01:00:00.000+0800'
            }
          },
          {
            id: '10002',
            key: 'BUG-2',
            fields: {
              summary: '完成状态问题',
              status: { name: '完成', statusCategory: { name: 'Done', key: 'done' } },
              assignee: { displayName: '李四' },
              issuetype: { name: 'Bug' },
              project: { key: 'BUG' },
              created: '2026-05-01T00:00:00.000+0800',
              updated: '2026-05-04T00:00:00.000+0800',
              resolutiondate: null,
              statuscategorychangedate: '2026-05-03T00:00:00.000+0800'
            }
          }
        ]
      });
    };

    const result = await searchAndAnalyzeJira({
      projectKey: 'BUG',
      statusCategory: 'Done',
      maxResults: 10,
      orderBy: 'resolutiondate DESC, updated DESC',
      includeCompletionTiming: true,
      clientOperation: true
    }, { baizeRoot, fetchImpl });

    expect(searchBody.fields).toEqual(expect.arrayContaining(['resolutiondate', 'statuscategorychangedate']));
    expect(searchBody.jql).toContain('statusCategory = "Done"');
    expect(searchBody.jql).toContain('ORDER BY resolutiondate DESC, updated DESC');
    expect(result.issues[0].timing).toMatchObject({ completionSource: 'resolutiondate', completionDurationMs: 86400000 });
    expect(result.issues[1].timing).toMatchObject({ completionSource: 'statuscategorychangedate', completionDurationMs: 172800000 });
    expect(result.timingAnalysis).toMatchObject({
      totalIssues: 2,
      issuesWithCompletion: 2,
      averageCompletionMs: 129600000,
      averageCompletionHours: 36,
      averageCompletionDays: 1.5,
      completionSources: { resolutiondate: 1, statuscategorychangedate: 1 }
    });
  });

  it('resolves Chinese assignee names before building Jira search JQL', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      return jsonResponse({ total: 1, issues: [] });
    };

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然' }, { baizeRoot, fetchImpl });
    const searchRequest = requests.find((item) => item.url.endsWith('/rest/api/2/search'));
    const body = JSON.parse(searchRequest.options.body);

    expect(requests.some((item) => item.url.includes('/rest/api/2/user/search?username=%E6%9B%BE%E6%B5%A9%E7%84%B6'))).toBe(true);
    expect(body.jql).toContain('(assignee = "zenghaoran" OR "任务负责人" = "zenghaoran")');
    expect(body.jql).not.toContain('JIRAUSER10304');
    expect(result.resolvedUsers).toEqual(['曾浩然-客户端']);
  });

  it('asks Claude Code to resolve ambiguous Jira user candidates before searching', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([
          { name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true },
          { name: 'zenghaoran2', key: 'JIRAUSER20000', displayName: '曾浩然-策划', active: true }
        ]);
      }
      return jsonResponse({ total: 1, issues: [] });
    };
    const claudeCodeRunner = async ({ prompt, permissionMode }) => {
      expect(permissionMode).toBe('read_only');
      expect(prompt).toContain('Jira 搜索歧义分析器');
      return JSON.stringify({
        kind: 'jira_search_candidate_resolution',
        status: 'resolved',
        selectedUserNames: ['zenghaoran'],
        reason: '原始查询更匹配客户端负责人'
      });
    };

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然' }, { baizeRoot, fetchImpl, claudeCodeRunner });
    const searchRequest = requests.find((item) => item.url.endsWith('/rest/api/2/search'));
    const body = JSON.parse(searchRequest.options.body);

    expect(body.jql).toContain('(assignee = "zenghaoran" OR "任务负责人" = "zenghaoran")');
    expect(body.jql).not.toContain('zenghaoran2');
    expect(body.jql).not.toContain('JIRAUSER10304');
    expect(result.userResolution[0]).toMatchObject({ term: '曾浩然', status: 'resolved', reason: '原始查询更匹配客户端负责人' });
    expect(result.resolvedUsers).toEqual(['曾浩然-客户端']);
  });

  it('converts bug label search and multiple statuses into executable JQL', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      return jsonResponse({ total: 2, issues: [] });
    };

    await searchAndAnalyzeJira({ assignee: '曾浩然', labels: ['BUG'], status: '未开始,处理中' }, { baizeRoot, fetchImpl });
    const searchRequest = requests.find((item) => item.url.endsWith('/rest/api/2/search'));
    const body = JSON.parse(searchRequest.options.body);

    expect(body.jql).toContain('project = "BUG"');
    expect(body.jql).toContain('status in ("未开始", "处理中")');
    expect(body.jql).toContain('(assignee = "zenghaoran" OR "任务负责人" = "zenghaoran")');
    expect(body.jql).not.toContain('labels');
    expect(body.jql).not.toContain('JIRAUSER10304');
  });

  it('asks Claude Code to rewrite Jira search JQL after a Jira /search 400 and retries safely', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const searches = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      searches.push(JSON.parse(options.body));
      if (searches.length === 1) {
        return jsonResponse({ errorMessages: ['字段"labels"不存在。'] }, { status: 400 });
      }
      return jsonResponse({ total: 1, issues: [{ key: 'BUG-1', fields: { summary: '回退后的查询', status: { name: '处理中' } } }] });
    };
    const claudeCallPrompts = [];
    const claudeCodeRunner = async ({ prompt, permissionMode }) => {
      claudeCallPrompts.push({ prompt, permissionMode });
      if (permissionMode === 'jira_search_error_analysis') {
        return JSON.stringify({
          kind: 'jira_search_recovery',
          plugin: 'jira',
          status: 'retry_available',
          summary: '移除不支持的 labels 字段后重试。',
          reason: '当前 Jira 不支持 labels 字段。',
          action: { id: 'retry_with_rewritten_jql', label: '使用修正后的 JQL 重试', requiresConfirmation: false },
          retry: { jql: 'project = "BUG" AND status = "处理中" ORDER BY updated DESC' }
        });
      }
      return null;
    };

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然', labels: ['BUG', 'X'], status: '处理中' }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(searches).toHaveLength(2);
    expect(searches[1].jql).toBe('project = "BUG" AND status = "处理中" ORDER BY updated DESC');
    expect(result.issues).toEqual([expect.objectContaining({ key: 'BUG-1', status: '处理中' })]);
    expect(result.originalJql).toContain('labels = "X"');
    expect(result.jiraSearchRecovery).toMatchObject({ status: 'retry_succeeded', attempts: 1 });
    expect(claudeCallPrompts.some((call) => call.permissionMode === 'jira_search_error_analysis')).toBe(true);
  });

  it('asks Claude Code to analyze Jira search timeouts and retries with rewritten JQL', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const searches = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      searches.push(JSON.parse(options.body));
      if (searches.length === 1) {
        return new Promise(() => {});
      }
      return jsonResponse({
        total: 1,
        issues: [{
          id: '10001',
          key: 'BUG-1',
          fields: {
            summary: '超时后缩小条件成功',
            status: { name: '未开始' },
            assignee: { displayName: '曾浩然-客户端' },
            issuetype: { name: 'Bug' },
            project: { key: 'BUG' }
          }
        }]
      });
    };
    const claudeFailures = [];
    const claudeCodeRunner = async ({ permissionMode, searchFailure }) => {
      if (permissionMode !== 'jira_search_error_analysis') {
        return null;
      }
      claudeFailures.push(searchFailure);
      return JSON.stringify({
        kind: 'jira_search_recovery',
        plugin: 'jira',
        status: 'retry_available',
        summary: 'Jira 查询超时，缩小到 BUG 未开始状态后重试。',
        reason: '原查询执行超过 30 秒。',
        action: { id: 'retry_with_rewritten_jql', label: '使用修正后的 JQL 重试', requiresConfirmation: false },
        retry: { jql: 'project = "BUG" AND status = "未开始" ORDER BY updated DESC' }
      });
    };

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然' }, { baizeRoot, fetchImpl, claudeCodeRunner, jiraTimeoutMs: 5 });

    expect(searches).toHaveLength(2);
    expect(claudeFailures[0].error.code).toBe('JIRA_REQUEST_TIMEOUT');
    expect(claudeFailures[0].classification).toEqual({ type: 'timeout' });
    expect(searches[1].jql).toBe('project = "BUG" AND status = "未开始" ORDER BY updated DESC');
    expect(result.issues[0]).toMatchObject({ key: 'BUG-1', summary: '超时后缩小条件成功' });
    expect(result.jiraSearchRecovery).toMatchObject({ status: 'retry_succeeded', attempts: 1 });
  });

  it('rejects unsafe rewritten JQL from Claude Code and returns not recoverable result', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const searches = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      searches.push(JSON.parse(options.body));
      return jsonResponse({ errorMessages: ['字段"labels"不存在。'] }, { status: 400 });
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_search_recovery',
      plugin: 'jira',
      status: 'retry_available',
      action: { id: 'retry_with_rewritten_jql', label: '重试', requiresConfirmation: false },
      retry: { jql: 'DROP TABLE issues' }
    });

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然', labels: ['BUG'] }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(searches).toHaveLength(1);
    expect(result.notRecoverable).toBe(true);
    expect(result.jiraSearchRecovery.status).toBe('not_recoverable');
    expect(JSON.stringify(result)).not.toContain('DROP TABLE');
  });

  it('returns user supplement when Claude Code says Jira search needs user input', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const searches = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      searches.push(JSON.parse(options.body));
      return jsonResponse({ errorMessages: ['"status"字段中没有"未开始"值。'] }, { status: 400 });
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_search_recovery',
      plugin: 'jira',
      status: 'needs_user_input',
      summary: '需要用户挑选合法状态。',
      reason: 'Jira 不存在“未开始”状态。',
      action: { id: 'ask_user_for_search_input', label: '请求用户补充状态', requiresConfirmation: false },
      supplement: { prompt: '请选择正确的 Jira 状态', inputs: [{ id: 'status', type: 'select', label: 'Jira 状态', required: true, options: ['待处理', '进行中'] }] }
    });

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然', status: '未开始' }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(searches).toHaveLength(1);
    expect(result.requiresUserInput).toBe(true);
    expect(result.supplement.inputs[0].id).toBe('status');
    expect(result.jiraSearchRecovery.status).toBe('needs_user_input');
  });

  it('returns not recoverable after Jira /search keeps failing up to 3 recovery retries', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const searches = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([{ name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true }]);
      }
      searches.push(JSON.parse(options.body));
      return jsonResponse({ errorMessages: ['Jira 持续报错。'] }, { status: 400 });
    };
    let counter = 0;
    const claudeCodeRunner = async ({ permissionMode }) => {
      if (permissionMode !== 'jira_search_error_analysis') {
        return null;
      }
      counter += 1;
      return JSON.stringify({
        kind: 'jira_search_recovery',
        plugin: 'jira',
        status: 'retry_available',
        action: { id: 'retry_with_rewritten_jql', label: '重试', requiresConfirmation: false },
        retry: { jql: `project = "BUG" AND status = "处理中-${counter}" ORDER BY updated DESC` }
      });
    };

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然', status: '处理中' }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(counter).toBe(3);
    expect(searches).toHaveLength(4);
    expect(result.notRecoverable).toBe(true);
    expect(result.jiraSearchRecovery.status).toBe('not_recoverable');
    expect(result.jiraSearchRecovery.attempts).toBe(3);
  });

  it('returns a client supplement only when Claude Code cannot resolve Jira user ambiguity', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/rest/api/2/user/search')) {
        return jsonResponse([
          { name: 'zenghaoran', key: 'JIRAUSER10304', displayName: '曾浩然-客户端', active: true },
          { name: 'zenghaoran2', key: 'JIRAUSER20000', displayName: '曾浩然-策划', active: true }
        ]);
      }
      throw new Error('Jira issue search should not run before user supplement');
    };
    const claudeCodeRunner = async () => JSON.stringify({
      kind: 'jira_search_candidate_resolution',
      status: 'needs_user_input',
      reason: '两个候选都可能符合，需要用户确认。',
      choices: [
        { value: 'zenghaoran', label: '曾浩然-客户端' },
        { value: 'zenghaoran2', label: '曾浩然-策划' }
      ]
    });

    const result = await searchAndAnalyzeJira({ assignee: '曾浩然' }, { baizeRoot, fetchImpl, claudeCodeRunner });

    expect(result.requiresUserInput).toBe(true);
    expect(result.supplement).toMatchObject({
      prompt: '两个候选都可能符合，需要用户确认。',
      inputs: [{ id: 'jiraUser:曾浩然', type: 'select', label: '选择 Jira 用户：曾浩然', required: true, options: ['zenghaoran', 'zenghaoran2'] }]
    });
    expect(result.supplement.choices).toEqual([
      { value: 'zenghaoran', label: '曾浩然-客户端' },
      { value: 'zenghaoran2', label: '曾浩然-策划' }
    ]);
    expect(requests.some((item) => item.url.endsWith('/rest/api/2/search'))).toBe(false);
  });

  it('creates Jira drafts from text lines', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);

    const result = await createJiraImportDrafts({
      fileName: '需求.txt',
      text: '登录页错误提示改中文|所有用户可见错误都要中文化\n上传区支持图片缩略图'
    }, { baizeRoot });

    expect(result.count).toBe(2);
    expect(result.drafts[0]).toMatchObject({
      summary: '登录页错误提示改中文',
      description: '所有用户可见错误都要中文化',
      projectKey: 'BZ',
      issueType: 'Story'
    });
  });

  it('creates Jira drafts from natural language with project key', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);

    const result = await createJiraImportDrafts({
      fileName: '需求.txt',
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE'
    }, { baizeRoot });

    expect(result.drafts[0]).toMatchObject({
      summary: '测试',
      projectKey: 'BATTLE',
      issueType: 'Story'
    });
    expect(result.warnings).toEqual([]);
  });

  it('creates Jira drafts from uploaded attachments', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const attachment = await uploadAttachment({
      fileName: '需求.txt',
      contentBase64: Buffer.from('附件需求|从上传附件创建 Jira 单').toString('base64'),
      conversationId: 'conversation-1',
      clientId: 'desktop-client-1'
    }, { baizeRoot });

    const result = await createJiraImportDrafts({ attachmentId: attachment.id }, { baizeRoot });

    expect(result.count).toBe(1);
    expect(result.drafts[0]).toMatchObject({
      summary: '附件需求',
      description: '从上传附件创建 Jira 单',
      projectKey: 'BZ'
    });
  });

  it('does not parse xlsx files locally before Claude reads them', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);

    await expect(createJiraImportDrafts({
      fileName: '需求.xlsx',
      contentBase64: Buffer.from('fake-xlsx').toString('base64')
    }, { baizeRoot })).rejects.toMatchObject({
      publicMessage: 'xlsx 文件需要先交由 Claude 读取解析后再生成 Jira 草稿。'
    });
  });

  it('confirms Jira bulk create operations only after preview', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '创建需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: [] }]
    }, { baizeRoot });
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      return jsonResponse({ id: '10001', key: 'BZ-1', self: 'http://127.0.0.1:8080/rest/api/2/issue/10001' });
    };

    const confirmed = await confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl });

    expect(confirmed.status).toBe('created');
    expect(confirmed.createdIssues).toEqual([expect.objectContaining({ key: 'BZ-1', summary: '创建需求单' })]);
    expect(requests[0].url).toBe('http://127.0.0.1:8080/rest/api/2/project/BZ');
    expect(requests[1].url).toBe('http://127.0.0.1:8080/rest/api/2/issue');
    const fields = JSON.parse(requests[1].options.body).fields;
    expect(fields.summary).toBe('创建需求单');
    expect(fields.issuetype).toEqual({ id: '10001' });
    expect(fields.assignee).toBeUndefined();
  });

  it('surfaces Jira field errors from failed API responses', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const fetchImpl = async () => jsonResponse({
      errorMessages: [],
      errors: { issuetype: '指定的问题类型无效' }
    }, { status: 400 });

    await expect(requestJira(await require('../src/services/config-service').getJiraConfig({ baizeRoot }), '/issue', {
      method: 'POST',
      body: { fields: {} },
      fetchImpl
    })).rejects.toMatchObject({
      code: 'JIRA_API_ERROR',
      publicMessage: '问题类型: 指定的问题类型无效'
    });
  });

  it('translates Jira screen field errors before sending them to clients', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const fetchImpl = async () => jsonResponse({
      errorMessages: [],
      errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." }
    }, { status: 400 });

    await expect(requestJira(await require('../src/services/config-service').getJiraConfig({ baizeRoot }), '/issue', {
      method: 'POST',
      body: { fields: {} },
      fetchImpl
    })).rejects.toMatchObject({
      code: 'JIRA_API_ERROR',
      publicMessage: '标签: 标签字段不能创建：该字段不在当前 Jira 创建界面中，或 Jira 不认识这个字段。'
    });
  });

  it('creates missing Jira project key operations as user-input recovery cards', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '缺项目需求单', description: '确认前补项目', issueType: 'Story', labels: [] }]
    }, { baizeRoot });

    expect(operation).toMatchObject({
      status: 'recovery_required',
      error: '存在未配置项目 Key 的草稿，确认创建前需要补充项目。',
      failure: {
        code: 'JIRA_PROJECT_REQUIRED',
        requiresUserInput: true,
        classification: { safeDefaultRecovery: 'submit_supplement' }
      },
      recovery: {
        status: 'needs_user_input',
        supplement: { inputs: [expect.objectContaining({ id: 'projectKey' })] },
        actions: expect.arrayContaining([expect.objectContaining({ id: 'submit_supplement' })])
      }
    });
    expect(operation.draftImport.warnings).toEqual([]);
  });

  it('stores structured failure context for Jira labels screen errors', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '带标签需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: ['jump'] }]
    }, { baizeRoot });
    const fetchImpl = async (url) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      return jsonResponse({
        errorMessages: [],
        errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." }
      }, { status: 400 });
    };

    await expect(confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl })).rejects.toMatchObject({ code: 'JIRA_API_ERROR' });

    const failed = await getJiraOperation(operation.id, { baizeRoot });
    expect(failed).toMatchObject({
      status: 'failed',
      failure: {
        code: 'JIRA_API_ERROR',
        failedDraftIndex: 0,
        classification: { safeDefaultRecovery: 'retry_without_labels' },
        sanitizedRequestContext: {
          fieldKeysAttempted: expect.arrayContaining(['labels'])
        }
      }
    });
  });

  it('prechecks Jira create metadata and fails before issue POST when labels are unsupported', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '带标签需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: ['jump'] }]
    }, { baizeRoot });
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: 'Story' }] });
      }
      if (url.includes('/rest/api/2/issue/createmeta')) {
        return jsonResponse({
          projects: [{
            key: 'BZ',
            issuetypes: [{ id: '10001', name: 'Story', fields: { summary: {}, project: {}, issuetype: {} } }]
          }]
        });
      }
      throw new Error('issue POST should not be called');
    };

    await expect(confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl })).rejects.toMatchObject({ code: 'JIRA_API_ERROR' });

    const failed = await getJiraOperation(operation.id, { baizeRoot });
    expect(requests.some((url) => url.includes('/rest/api/2/issue/createmeta'))).toBe(true);
    expect(requests.some((url) => url.endsWith('/rest/api/2/issue'))).toBe(false);
    expect(failed).toMatchObject({
      status: 'failed',
      failure: {
        classification: { safeDefaultRecovery: 'retry_without_labels' },
        sanitizedRequestContext: { fieldKeysAttempted: expect.arrayContaining(['labels']) }
      }
    });
  });

  it('retries Jira creation without labels after recovery confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '带标签需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: ['jump'] }]
    }, { baizeRoot });
    const createRequests = [];
    let shouldFail = true;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      createRequests.push(JSON.parse(options.body).fields);
      if (shouldFail) {
        shouldFail = false;
        return jsonResponse({
          errorMessages: [],
          errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." }
        }, { status: 400 });
      }
      return jsonResponse({ id: '10010', key: 'BZ-10', self: 'http://jira/rest/api/2/issue/10010' });
    };

    await expect(confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl })).rejects.toMatchObject({ code: 'JIRA_API_ERROR' });
    await attachJiraOperationRecovery(operation.id, null, { baizeRoot });

    const recovered = await applyJiraOperationRecovery(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      actionId: 'retry_without_labels'
    }, { baizeRoot, fetchImpl });

    expect(recovered.status).toBe('created');
    expect(recovered.createdIssues).toEqual([expect.objectContaining({ key: 'BZ-10' })]);
    expect(createRequests[0].labels).toEqual(['jump']);
    expect(createRequests[1].labels).toBeUndefined();
  });

  it('does not duplicate already created Jira issues during recovery retry', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 2,
      drafts: [
        { summary: '第一个需求单', description: '已成功', projectKey: 'BZ', issueType: 'Story', labels: ['jump'] },
        { summary: '第二个需求单', description: '需要恢复', projectKey: 'BZ', issueType: 'Story', labels: ['jump'] }
      ]
    }, { baizeRoot });
    const createRequests = [];
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      const fields = JSON.parse(options.body).fields;
      createRequests.push(fields);
      if (createRequests.length === 1) {
        return jsonResponse({ id: '10001', key: 'BZ-1', self: 'http://jira/rest/api/2/issue/10001' });
      }
      if (createRequests.length === 2) {
        return jsonResponse({
          errorMessages: [],
          errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." }
        }, { status: 400 });
      }
      return jsonResponse({ id: '10002', key: 'BZ-2', self: 'http://jira/rest/api/2/issue/10002' });
    };

    await expect(confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl })).rejects.toMatchObject({ code: 'JIRA_API_ERROR' });
    await attachJiraOperationRecovery(operation.id, null, { baizeRoot });

    const recovered = await applyJiraOperationRecovery(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      actionId: 'retry_without_labels'
    }, { baizeRoot, fetchImpl });

    expect(recovered.status).toBe('created');
    expect(recovered.createdIssues.map((issue) => issue.key)).toEqual(['BZ-1', 'BZ-2']);
    expect(createRequests).toHaveLength(3);
    expect(createRequests[2].summary).toBe('第二个需求单');
    expect(createRequests[2].labels).toBeUndefined();
  });

  it('parses natural language assignee from initial Jira create request', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);

    const result = await createJiraImportDrafts({
      fileName: '需求.txt',
      text: '给曾浩然创建一个jira单子单子名字就叫做测试 项目key:BATTLE'
    }, { baizeRoot });

    expect(result.drafts[0]).toMatchObject({
      summary: '测试',
      projectKey: 'BATTLE',
      assignee: '曾浩然'
    });
  });

  it('maps task owner custom field when creating Jira issues', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: basic',
      'username: jira-user',
      'password: jira-password',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Story',
      'fields:',
      '  taskOwner: customfield_10130'
    ].join('\n'), 'utf8');
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '负责人需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', assignee: 'zhangsan', labels: [] }]
    }, { baizeRoot });
    let request;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      if (url.endsWith('/rest/api/2/field')) {
        return jsonResponse([{ id: 'customfield_10130', schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' } }]);
      }
      request = { url, options };
      return jsonResponse({ id: '10003', key: 'BZ-3', self: 'http://127.0.0.1:8080/rest/api/2/issue/10003' });
    };

    await confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl });

    const fields = JSON.parse(request.options.body).fields;
    expect(fields.assignee).toEqual({ name: 'zhangsan' });
    expect(fields.customfield_10130).toEqual({ name: 'zhangsan' });
  });

  it('does not write task owner mapping into Jira system status field', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'apiVersion: "2"',
      'authType: basic',
      'username: jira-user',
      'password: jira-password',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Story',
      'fields:',
      '  taskOwner: status'
    ].join('\n'), 'utf8');
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '负责人需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', assignee: 'zhangsan', labels: [] }]
    }, { baizeRoot });
    let request;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      request = { url, options };
      return jsonResponse({ id: '10004', key: 'BZ-4', self: 'http://127.0.0.1:8080/rest/api/2/issue/10004' });
    };

    await confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl });

    const fields = JSON.parse(request.options.body).fields;
    expect(fields.assignee).toEqual({ name: 'zhangsan' });
    expect(fields.status).toBeUndefined();
  });

  it('uses Jira Server assignee name when creating issues', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeJiraConfig(baizeRoot);
    const operation = await createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '指派需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', assignee: 'zhangsan', labels: [] }]
    }, { baizeRoot });
    let request;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/rest/api/2/project/BZ')) {
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
      request = { url, options };
      return jsonResponse({ id: '10002', key: 'BZ-2', self: 'http://127.0.0.1:8080/rest/api/2/issue/10002' });
    };

    await confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    }, { baizeRoot, fetchImpl });

    expect(JSON.parse(request.options.body).fields.assignee).toEqual({ name: 'zhangsan' });
  });
});
