const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const { createLocalJiraService } = require('../client/desktop/local-jira-service.cjs');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

function createService(userDataPath, { fetchImpl, fieldMappings } = {}) {
  return createLocalJiraService({
    userDataPath,
    fetchImpl,
    configStore: {
      getConfig: async () => ({
        enabled: true,
        baseURL: 'http://jira.test',
        deploymentType: 'server',
        apiVersion: '2',
        authType: 'basic',
        username: 'jira-user',
        password: 'jira-password',
        defaultProjectKey: 'BZ',
        defaultIssueType: 'Story',
        fieldMappings: fieldMappings || {}
      })
    }
  });
}

describe('desktop local Jira service', () => {
  it('creates local Jira import drafts with operation cards', async () => {
    const { baizeRoot } = await createTestRoot();
    const service = createService(path.join(baizeRoot, 'user-data'));

    const result = await service.createJiraImportDraftsWithOperation({
      fileName: '需求.txt',
      text: '登录页错误提示改中文|所有用户可见错误都要中文化',
      clientId: 'desktop-client-1',
      userId: 'desktop-user',
      conversationId: 'conversation-1'
    });

    expect(result.count).toBe(1);
    expect(result.operation).toMatchObject({
      kind: 'jira_bulk_create',
      status: 'awaiting_confirmation',
      clientId: 'desktop-client-1',
      userId: 'desktop-user',
      conversationId: 'conversation-1',
      draftImport: {
        fileName: '需求.txt',
        drafts: [expect.objectContaining({ summary: '登录页错误提示改中文', projectKey: 'BZ', issueType: 'Story' })]
      }
    });
  });

  it('marks local Jira operations as confirmed before Claude Code executes tools', async () => {
    const { baizeRoot } = await createTestRoot();
    const service = createService(path.join(baizeRoot, 'user-data'));
    const operation = await service.createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '创建需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: [] }]
    });

    const confirmed = await service.confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    });

    expect(confirmed.status).toBe('confirmed_running');
    expect(confirmed.createdIssues).toEqual([]);
  });

  it('creates confirmed Jira issues through local Jira tool calls', async () => {
    const { baizeRoot } = await createTestRoot();
    const requests = [];
    const service = createService(path.join(baizeRoot, 'user-data'), {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/rest/api/2/project/BZ')) {
          return jsonResponse({ id: '10000', key: 'BZ', name: '白泽', issueTypes: [{ id: '10001', name: '需求' }] });
        }
        return jsonResponse({ id: '10001', key: 'BZ-1', self: 'http://jira.test/rest/api/2/issue/10001' });
      }
    });
    const operation = await service.createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '创建需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: [] }]
    });
    await service.confirmJiraOperation(operation.id, { clientId: 'desktop-client-1', conversationId: 'conversation-1' });

    const project = await service.getJiraProject({ projectKey: 'BZ' });
    const result = await service.createConfirmedJiraIssue(operation.id, { draftIndex: 0, draft: { issueTypeId: '10001' } }, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    });

    expect(project).toEqual({ id: '10000', key: 'BZ', name: '白泽', issueTypes: [{ id: '10001', name: '需求', subtask: false }] });
    expect(result.operation.status).toBe('created');
    expect(result.operation.createdIssues).toEqual([expect.objectContaining({ key: 'BZ-1', summary: '创建需求单' })]);
    expect(requests[0].url).toBe('http://jira.test/rest/api/2/project/BZ');
    expect(requests[1].url).toBe('http://jira.test/rest/api/2/issue');
    expect(requests[1].options.headers.Authorization).toMatch(/^Basic /);
    const fields = JSON.parse(requests[1].options.body).fields;
    expect(fields.summary).toBe('创建需求单');
    expect(fields.issuetype).toEqual({ id: '10001' });
  });

  it('creates missing project key operations as local recovery cards', async () => {
    const { baizeRoot } = await createTestRoot();
    const service = createService(path.join(baizeRoot, 'user-data'), {
      configStore: {
        getConfig: async () => ({ enabled: true, defaultIssueType: 'Task' })
      }
    });

    const operation = await service.createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '缺项目需求单', description: '确认前补项目', issueType: 'Story', labels: [] }]
    });

    expect(operation).toMatchObject({
      status: 'recovery_required',
      error: '存在未配置项目 Key 的草稿，确认创建前需要补充项目。',
      failure: { code: 'JIRA_PROJECT_REQUIRED', classification: { safeDefaultRecovery: 'submit_supplement' } },
      recovery: {
        analyzedBy: 'client',
        status: 'needs_user_input',
        supplement: { inputs: [expect.objectContaining({ id: 'projectKey' })] }
      }
    });
  });

  it('creates invalid project key imports as local recovery cards before confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    const requests = [];
    const service = createService(path.join(baizeRoot, 'user-data'), {
      fetchImpl: async (url) => {
        requests.push(url);
        if (url.endsWith('/rest/api/2/project/JUMP')) {
          return jsonResponse({}, { status: 404 });
        }
        return jsonResponse({ issueTypes: [{ id: '10001', name: '需求' }] });
      }
    });

    const result = await service.createJiraImportDraftsWithOperation({
      fileName: 'local-claude-code-jira-intent.json',
      drafts: [{ summary: '无效项目需求单', description: '确认前校验项目', projectKey: 'JUMP', issueType: 'Story', labels: [] }],
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    });

    expect(result.operation).toMatchObject({
      status: 'recovery_required',
      error: '存在 Jira 无法识别的项目 Key，确认创建前需要补充或修正项目。',
      failure: {
        classification: { type: 'invalid_project_key', safeDefaultRecovery: 'submit_supplement' },
        sanitizedRequestContext: { invalidProjectKeyCount: 1 }
      },
      recovery: {
        summary: '创建 Jira 前需要修正项目 Key。',
        reason: expect.stringContaining('项目不存在、Key 写错，或账号没有项目权限')
      }
    });
    expect(result.operation.draftImport.drafts[0]).toMatchObject({ projectKey: 'JUMP', projectValid: false });
    expect(requests).toContain('http://jira.test/rest/api/2/project/JUMP');
  });

  it('retries local Jira creation without labels after recovery', async () => {
    const { baizeRoot } = await createTestRoot();
    const createRequests = [];
    let shouldFail = true;
    const service = createService(path.join(baizeRoot, 'user-data'), {
      fetchImpl: async (url, options) => {
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
        return jsonResponse({ id: '10010', key: 'BZ-10', self: 'http://jira.test/rest/api/2/issue/10010' });
      }
    });
    const operation = await service.createJiraCreateOperation({
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      fileName: '需求.txt',
      count: 1,
      drafts: [{ summary: '带标签需求单', description: '确认后创建', projectKey: 'BZ', issueType: 'Story', labels: ['jump'] }]
    });

    const confirmed = await service.confirmJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    });
    expect(confirmed.status).toBe('confirmed_running');

    const failed = await service.createConfirmedJiraIssue(operation.id, { draftIndex: 0 }, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1'
    });
    expect(failed.ok).toBe(false);
    expect(failed.operation.status).toBe('failed');

    const recovered = await service.recoverJiraOperation(operation.id, {
      clientId: 'desktop-client-1',
      conversationId: 'conversation-1',
      actionId: 'retry_without_labels'
    });

    expect(recovered.status).toBe('created');
    expect(recovered.createdIssues).toEqual([expect.objectContaining({ key: 'BZ-10' })]);
    expect(createRequests[0].labels).toEqual(['jump']);
    expect(createRequests[1].labels).toBeUndefined();
  });
});
