const fs = require('fs/promises');
const path = require('path');

function getSyncStorePaths(userDataPath) {
  const root = path.join(userDataPath, 'sync');
  return {
    root,
    stateFile: path.join(root, 'state.json'),
    eventsFile: path.join(root, 'events.jsonl'),
    memoryFile: path.join(root, 'memory.json'),
    logicFile: path.join(root, 'logic.json'),
    auditFile: path.join(root, 'audit.json'),
    pluginFile: path.join(root, 'plugins.json'),
    runtimeFile: path.join(root, 'runtime.json')
  };
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim() === '' ? fallback : JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function categoryForEventType(type) {
  if (type === 'memory.created' || type === 'memory.updated') {
    return 'memory';
  }
  if (type === 'logic_assertion.created' || type === 'logic_assertion.updated') {
    return 'logic';
  }
  if (type === 'audit.created' || type === 'audit.updated') {
    return 'audit';
  }
  if (type === 'plugin.updated') {
    return 'plugin';
  }
  if (type === 'client_runtime.updated') {
    return 'runtime';
  }
  return null;
}

function itemIdForEvent(event) {
  const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
  return payload.id || payload.key || payload.name || event.id || `version-${event.version}`;
}

async function upsertIndexedItem(filePath, event) {
  const current = await readJson(filePath, { items: [] });
  const items = Array.isArray(current.items) ? current.items : [];
  const id = itemIdForEvent(event);
  const item = {
    id,
    type: event.type,
    version: Number(event.version) || 0,
    clientId: event.clientId || '',
    userId: event.userId || '',
    payload: event.payload || {},
    receivedAt: event.receivedAt || '',
    syncedAt: new Date().toISOString()
  };
  await writeJson(filePath, {
    items: [item, ...items.filter((existing) => existing.id !== id)].slice(0, 1000)
  });
  return item;
}

function createLocalSyncStore(userDataPath) {
  const storePaths = getSyncStorePaths(userDataPath);

  async function getState() {
    const state = await readJson(storePaths.stateFile, { lastVersion: 0, updatedAt: '' });
    return {
      lastVersion: Number(state.lastVersion) || 0,
      updatedAt: state.updatedAt || ''
    };
  }

  async function setLastVersion(lastVersion) {
    const state = {
      lastVersion: Math.max(0, Number(lastVersion) || 0),
      updatedAt: new Date().toISOString()
    };
    await writeJson(storePaths.stateFile, state);
    return state;
  }

  async function applyEvent(event = {}) {
    const version = Number(event.version) || 0;
    if (!version || typeof event.type !== 'string') {
      return null;
    }
    await appendJsonLine(storePaths.eventsFile, event);
    const category = categoryForEventType(event.type);
    let item = null;
    if (category === 'memory') {
      item = await upsertIndexedItem(storePaths.memoryFile, event);
    } else if (category === 'logic') {
      item = await upsertIndexedItem(storePaths.logicFile, event);
    } else if (category === 'audit') {
      item = await upsertIndexedItem(storePaths.auditFile, event);
    } else if (category === 'plugin') {
      item = await upsertIndexedItem(storePaths.pluginFile, event);
    } else if (category === 'runtime') {
      item = await upsertIndexedItem(storePaths.runtimeFile, event);
    }
    const state = await getState();
    if (version > state.lastVersion) {
      await setLastVersion(version);
    }
    return { category, item };
  }

  async function applyEvents(events = [], { lastVersion } = {}) {
    const applied = [];
    for (const event of Array.isArray(events) ? events : []) {
      const result = await applyEvent(event);
      if (result) {
        applied.push(result);
      }
    }
    if (lastVersion !== undefined) {
      const state = await getState();
      if (Number(lastVersion) > state.lastVersion) {
        await setLastVersion(lastVersion);
      }
    }
    return {
      state: await getState(),
      applied
    };
  }

  async function readCategory(category) {
    const fileMap = {
      memory: storePaths.memoryFile,
      logic: storePaths.logicFile,
      audit: storePaths.auditFile,
      plugin: storePaths.pluginFile,
      runtime: storePaths.runtimeFile
    };
    return readJson(fileMap[category], { items: [] });
  }

  return {
    getState,
    setLastVersion,
    applyEvent,
    applyEvents,
    readCategory
  };
}

module.exports = {
  createLocalSyncStore,
  categoryForEventType
};
