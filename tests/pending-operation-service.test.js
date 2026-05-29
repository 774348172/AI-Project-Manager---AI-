const {
  createPendingOperation,
  getOperation,
  confirmOperation,
  rejectOperation,
  recordApplicationResult
} = require('../src/services/pending-operation-service');
const { createTestRoot } = require('./helpers/test-root');

describe('pending operation service', () => {
  it('creates and loads pending operations', async () => {
    const { baizeRoot } = await createTestRoot();
    const operation = await createPendingOperation({
      conversationId: 'conversation-1',
      clientId: 'client-1',
      userId: 'user-1',
      text: '帮我修改代码',
      intent: { route: 'engineering_write' }
    }, { baizeRoot });

    expect(operation).toMatchObject({
      kind: 'claude_code_patch',
      status: 'awaiting_confirmation',
      conversationId: 'conversation-1',
      clientId: 'client-1',
      permission: { mode: 'write_proposal', requireConfirmation: true }
    });
    await expect(getOperation(operation.id, { baizeRoot })).resolves.toMatchObject({ id: operation.id });
  });

  it('confirms only matching active operations', async () => {
    const { baizeRoot } = await createTestRoot();
    const operation = await createPendingOperation({
      conversationId: 'conversation-1',
      clientId: 'client-1',
      text: '帮我修改代码'
    }, { baizeRoot });

    await expect(confirmOperation(operation.id, {
      conversationId: 'conversation-1',
      clientId: 'other-client'
    }, { baizeRoot })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(confirmOperation(operation.id, {
      conversationId: 'conversation-1',
      clientId: 'client-1'
    }, { baizeRoot })).resolves.toMatchObject({
      id: operation.id,
      status: 'confirmed',
      permission: expect.objectContaining({ confirmedAt: expect.any(String) })
    });
  });

  it('rejects operations and records local application results', async () => {
    const { baizeRoot } = await createTestRoot();
    const rejected = await createPendingOperation({ conversationId: 'conversation-1', text: '取消' }, { baizeRoot });
    await expect(rejectOperation(rejected.id, { conversationId: 'conversation-1' }, { baizeRoot }))
      .resolves.toMatchObject({ status: 'rejected' });

    const applied = await createPendingOperation({ conversationId: 'conversation-2', clientId: 'client-1', text: '应用' }, { baizeRoot });
    await expect(recordApplicationResult(applied.id, {
      conversationId: 'conversation-2',
      clientId: 'client-1',
      status: 'applied',
      appliedFiles: ['src/app.js']
    }, { baizeRoot })).resolves.toMatchObject({
      status: 'applied',
      application: expect.objectContaining({ appliedFiles: ['src/app.js'] })
    });
  });
});
