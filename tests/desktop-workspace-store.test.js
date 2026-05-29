const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createWorkspaceStore } = require('../client/desktop/workspace-store.cjs');

describe('desktop workspace store', () => {
  it('authorizes and activates local workspaces', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-user-data-'));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-workspace-'));
    const store = createWorkspaceStore(userDataPath);

    const workspace = await store.authorizeWorkspace(workspaceRoot);
    const list = await store.listWorkspaces();

    expect(workspace.rootPath).toBe(path.resolve(workspaceRoot));
    expect(list.activeWorkspaceId).toBe(workspace.id);
    expect(list.workspaces).toHaveLength(1);
    await expect(store.getActiveWorkspace()).resolves.toMatchObject({ id: workspace.id });
  });

  it('rejects invalid workspace ids', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-user-data-'));
    const store = createWorkspaceStore(userDataPath);

    await expect(store.getWorkspace('../bad')).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_ID' });
  });
});
