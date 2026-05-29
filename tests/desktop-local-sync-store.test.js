const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { createLocalSyncStore, categoryForEventType } = require('../client/desktop/local-sync-store.cjs');

const projectRoot = path.resolve(__dirname, '..');

async function makeTempUserData() {
  return fs.mkdtemp(path.join(projectRoot, '.test-desktop-sync-'));
}

describe('desktop local sync store', () => {
  it('maps sync event types to local categories', () => {
    expect(categoryForEventType('memory.created')).toBe('memory');
    expect(categoryForEventType('logic_assertion.updated')).toBe('logic');
    expect(categoryForEventType('audit.created')).toBe('audit');
    expect(categoryForEventType('plugin.updated')).toBe('plugin');
    expect(categoryForEventType('plugin.operation_requested')).toBe(null);
    expect(categoryForEventType('client_runtime.updated')).toBe('runtime');
    expect(categoryForEventType('unknown')).toBe(null);
  });

  it('applies sync events into local category caches and tracks last version', async () => {
    const userDataPath = await makeTempUserData();
    const store = createLocalSyncStore(userDataPath);

    try {
      const result = await store.applyEvents([
        {
          id: 'sync-1',
          version: 1,
          type: 'memory.created',
          clientId: 'client-a',
          payload: { id: 'memory-1', category: 'project', content: '服务器同步记忆。' }
        },
        {
          id: 'sync-2',
          version: 2,
          type: 'logic_assertion.created',
          clientId: 'client-b',
          payload: { id: 'logic-1', statement: '多人负责人需要拆单。' }
        }
      ], { lastVersion: 2 });

      expect(result.state.lastVersion).toBe(2);
      const memory = await store.readCategory('memory');
      const logic = await store.readCategory('logic');
      expect(memory.items[0]).toMatchObject({
        id: 'memory-1',
        type: 'memory.created',
        version: 1,
        payload: { category: 'project', content: '服务器同步记忆。' }
      });
      expect(logic.items[0]).toMatchObject({
        id: 'logic-1',
        type: 'logic_assertion.created',
        version: 2,
        payload: { statement: '多人负责人需要拆单。' }
      });
    } finally {
      if (fsSync.existsSync(userDataPath)) {
        await fs.rm(userDataPath, { recursive: true, force: true });
      }
    }
  });
});
