const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

function getWorkspacePath(userDataPath) {
  return path.join(userDataPath, 'workspaces.json');
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim() === '' ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validateWorkspaceId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(value)) {
    const error = new Error('工作区 ID 无效。');
    error.code = 'INVALID_WORKSPACE_ID';
    throw error;
  }
  return value;
}

async function normalizeWorkspacePath(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    const error = new Error('请选择有效的本地工作区。');
    error.code = 'INVALID_WORKSPACE_PATH';
    throw error;
  }

  const resolved = path.resolve(rootPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    const error = new Error('本地工作区必须是文件夹。');
    error.code = 'INVALID_WORKSPACE_PATH';
    throw error;
  }
  return resolved;
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    rootPath: workspace.rootPath,
    authorizedAt: workspace.authorizedAt,
    lastUsedAt: workspace.lastUsedAt
  };
}

function createWorkspaceStore(userDataPath) {
  async function readStore() {
    return readJson(getWorkspacePath(userDataPath), { workspaces: [], activeWorkspaceId: null });
  }

  async function writeStore(store) {
    await writeJson(getWorkspacePath(userDataPath), store);
  }

  async function listWorkspaces() {
    const store = await readStore();
    return {
      workspaces: store.workspaces.map(publicWorkspace),
      activeWorkspaceId: store.activeWorkspaceId
    };
  }

  async function authorizeWorkspace(rootPath) {
    const normalizedRoot = await normalizeWorkspacePath(rootPath);
    const store = await readStore();
    const existing = store.workspaces.find((workspace) => path.resolve(workspace.rootPath).toLowerCase() === normalizedRoot.toLowerCase());
    const timestamp = new Date().toISOString();
    if (existing) {
      existing.lastUsedAt = timestamp;
      store.activeWorkspaceId = existing.id;
      await writeStore(store);
      return publicWorkspace(existing);
    }

    const workspace = {
      id: `workspace-${crypto.randomUUID()}`,
      name: path.basename(normalizedRoot) || normalizedRoot,
      rootPath: normalizedRoot,
      authorizedAt: timestamp,
      lastUsedAt: timestamp
    };
    store.workspaces.unshift(workspace);
    store.activeWorkspaceId = workspace.id;
    await writeStore(store);
    return publicWorkspace(workspace);
  }

  async function getWorkspace(workspaceId) {
    const id = validateWorkspaceId(workspaceId);
    const store = await readStore();
    const workspace = store.workspaces.find((item) => item.id === id);
    if (!workspace) {
      const error = new Error('本地工作区未授权。');
      error.code = 'WORKSPACE_NOT_FOUND';
      throw error;
    }
    return publicWorkspace(workspace);
  }

  async function getActiveWorkspace() {
    const store = await readStore();
    if (!store.activeWorkspaceId) {
      return null;
    }
    return getWorkspace(store.activeWorkspaceId);
  }

  async function setActiveWorkspace(workspaceId) {
    const workspace = await getWorkspace(workspaceId);
    const store = await readStore();
    store.activeWorkspaceId = workspace.id;
    await writeStore(store);
    return workspace;
  }

  async function revokeWorkspace(workspaceId) {
    const id = validateWorkspaceId(workspaceId);
    const store = await readStore();
    store.workspaces = store.workspaces.filter((workspace) => workspace.id !== id);
    if (store.activeWorkspaceId === id) {
      store.activeWorkspaceId = store.workspaces[0] ? store.workspaces[0].id : null;
    }
    await writeStore(store);
    return listWorkspaces();
  }

  return {
    listWorkspaces,
    authorizeWorkspace,
    getWorkspace,
    getActiveWorkspace,
    setActiveWorkspace,
    revokeWorkspace
  };
}

module.exports = {
  createWorkspaceStore,
  normalizeWorkspacePath
};
