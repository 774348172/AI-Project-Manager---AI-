const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createConversationStore } = require('../client/desktop/conversation-store.cjs');

describe('desktop conversation store', () => {
  it('persists local conversations and messages', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-desktop-store-'));
    const store = createConversationStore(userDataPath);

    const conversation = await store.createConversation({ id: 'desktop-local-test', title: '本地会话' });
    await store.appendMessage(conversation.id, { role: 'user', text: '你好' });
    await store.appendMessage(conversation.id, { role: 'assistant', text: '白泽：你好', meta: 'provider: claude' });

    const list = await store.listConversations();
    const loaded = await store.getConversation(conversation.id);

    expect(list[0]).toMatchObject({
      id: 'desktop-local-test',
      title: '本地会话',
      turnCount: 2,
      lastMessagePreview: '白泽：你好'
    });
    expect(loaded.messages).toEqual([
      expect.objectContaining({ role: 'user', text: '你好' }),
      expect.objectContaining({ role: 'assistant', text: '白泽：你好', meta: 'provider: claude' })
    ]);
  });

  it('persists Jira operation cards on assistant messages', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-desktop-store-'));
    const store = createConversationStore(userDataPath);
    const conversation = await store.createConversation({ id: 'desktop-jira-test', title: 'Jira 会话' });

    await store.appendMessage(conversation.id, {
      role: 'assistant',
      text: '白泽：已解析 1 个 Jira 需求单草稿，请确认是否创建。',
      meta: 'provider: jira',
      jiraOperation: {
        id: 'jira-op-1',
        status: 'awaiting_confirmation',
        draftImport: {
          count: 1,
          drafts: [{ summary: '测试需求', projectKey: 'BATTLE', issueType: 'Task' }]
        }
      }
    });

    const loaded = await store.getConversation(conversation.id);

    expect(loaded.messages[0].jiraOperation).toMatchObject({
      id: 'jira-op-1',
      draftImport: { count: 1 }
    });
  });

  it('persists Jira Bug analysis cards on assistant messages', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-desktop-store-'));
    const store = createConversationStore(userDataPath);
    const conversation = await store.createConversation({ id: 'desktop-bug-analysis-test', title: 'BUG 分析会话' });

    await store.appendMessage(conversation.id, {
      role: 'assistant',
      text: '白泽：已创建工程级 BUG 分析后台任务。',
      meta: 'provider: jira',
      bugAnalysisRun: {
        id: 'bug-run-1',
        status: 'running',
        total: 10,
        items: [{ id: 'bug-item-1', issueKey: 'BUG-1', status: 'pending' }]
      }
    });

    const loaded = await store.getConversation(conversation.id);

    expect(loaded.messages[0].bugAnalysisRun).toMatchObject({
      id: 'bug-run-1',
      status: 'running',
      total: 10
    });
  });

  it('deletes local conversations and messages', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-desktop-store-'));
    const store = createConversationStore(userDataPath);
    const conversation = await store.createConversation({ id: 'desktop-delete-test', title: '待删除会话' });
    await store.appendMessage(conversation.id, { role: 'user', text: '删除测试' });

    await expect(store.deleteConversation(conversation.id)).resolves.toEqual({ deleted: true });
    await expect(store.listConversations()).resolves.toEqual([]);
    await expect(store.getConversation(conversation.id)).resolves.toEqual({ conversation: null, messages: [] });
  });

  it('rejects unsafe local conversation ids', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-desktop-store-'));
    const store = createConversationStore(userDataPath);

    await expect(store.createConversation({ id: '../outside' })).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(store.deleteConversation('../outside')).rejects.toMatchObject({ code: 'INVALID_ID' });
  });
});
