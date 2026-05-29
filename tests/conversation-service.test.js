const path = require('path');
const {
  appendConversationMessage,
  createConversation,
  getConversation,
  getConversationMessages,
  listConversations
} = require('../src/services/conversation-service');
const { createTestRoot } = require('./helpers/test-root');

describe('conversation service', () => {
  it('creates, lists, and loads server conversations', async () => {
    const { baizeRoot } = await createTestRoot();

    const conversation = await createConversation({
      id: 'desktop-test-conversation',
      title: '测试长会话',
      platform: 'desktop',
      userId: 'desktop-user',
      clientId: 'desktop-client'
    }, { baizeRoot });
    await appendConversationMessage(conversation.id, {
      role: 'user',
      text: '第一轮问题',
      platform: 'desktop',
      userId: 'desktop-user',
      clientId: 'desktop-client'
    }, { baizeRoot });
    await appendConversationMessage(conversation.id, {
      role: 'assistant',
      text: '第一轮回答',
      provider: 'local_kb'
    }, { baizeRoot });

    const conversations = await listConversations({ clientId: 'desktop-client' }, { baizeRoot });
    const loaded = await getConversation(conversation.id, { baizeRoot });

    expect(conversations[0]).toMatchObject({
      id: 'desktop-test-conversation',
      title: '测试长会话',
      turnCount: 2,
      lastMessagePreview: '第一轮回答'
    });
    expect(loaded.messages).toEqual([
      expect.objectContaining({ role: 'user', text: '第一轮问题' }),
      expect.objectContaining({ role: 'assistant', text: '第一轮回答', provider: 'local_kb' })
    ]);
  });

  it('rejects unsafe conversation ids', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(createConversation({ id: path.join('..', 'outside') }, { baizeRoot }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(getConversationMessages('../outside', { baizeRoot }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
