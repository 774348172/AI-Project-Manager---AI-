# 白泽 Phase 1 本地服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Node.js + Express 本地服务，让白泽可以通过 API 读写本地记忆、登记深层索引、提交逻辑断言草案，并预留插件接口。

**Architecture:** Express 只监听本地地址，路由层处理 HTTP，service 层处理业务规则，lib 层处理文件读写、Markdown 格式和统一响应。所有数据继续保存在 `G:/Robot/baize` 下的 Markdown/YAML 文件中，不连接真实企业微信、Jira 或项目知识库。

**Tech Stack:** Node.js CommonJS、Express、yaml、Vitest、Supertest、本地文件系统。

---

## Scope

Phase 1 创建本地服务和测试，不接入真实外部系统，不引入数据库，不执行删除、覆盖、批量修改等敏感操作。

## File Structure

### Create

- `package.json` — Node 项目脚本、运行依赖和测试依赖。
- `src/server.js` — 启动本地 Express 服务。
- `src/app.js` — 创建 Express app，注册路由和错误处理。
- `src/config/paths.js` — 集中定义白泽文件路径。
- `src/lib/file-store.js` — 受控文件读取、追加、路径存在性判断。
- `src/lib/markdown.js` — Markdown 条目格式化。
- `src/lib/response.js` — 统一 JSON 响应。
- `src/routes/health.routes.js` — 健康检查路由。
- `src/routes/config.routes.js` — 全局配置路由。
- `src/routes/memory.routes.js` — 记忆路由。
- `src/routes/logic.routes.js` — 逻辑路由。
- `src/routes/plugins.routes.js` — 插件占位路由。
- `src/services/config-service.js` — 读取 `global.md` 和 `global.yaml`。
- `src/services/memory-service.js` — 浅层记忆写入/查询、深层索引登记。
- `src/services/logic-service.js` — 主动逻辑断言写入、被动逻辑草案写入。
- `src/services/plugin-service.js` — 插件占位状态。
- `tests/helpers/test-root.js` — 测试临时根目录和种子文件工具。
- `tests/memory-service.test.js` — 记忆服务测试。
- `tests/logic-service.test.js` — 逻辑服务测试。
- `tests/api.test.js` — API 集成测试。

### Modify

- `baize/logic/assertions/drafts.md` — 由逻辑服务在首次被动草案写入时创建。

---

## Task 1: Initialize Node project and shared libraries

**Files:**
- Create: `package.json`
- Create: `src/config/paths.js`
- Create: `src/lib/response.js`
- Create: `src/lib/markdown.js`
- Create: `src/lib/file-store.js`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "baize-local-hub",
  "version": "0.1.0",
  "private": true,
  "description": "白泽 Phase 1 本地知识中枢服务",
  "main": "src/server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node src/server.js",
    "test": "vitest run --globals"
  },
  "dependencies": {
    "express": "^4.19.2",
    "yaml": "^2.4.5"
  },
  "devDependencies": {
    "supertest": "^7.0.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: command exits with code 0 and creates `node_modules/` plus `package-lock.json`.

- [ ] **Step 3: Write `src/config/paths.js`**

```js
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const baizeRoot = process.env.BAIZE_ROOT || path.join(projectRoot, 'baize');

const paths = {
  PROJECT_ROOT: projectRoot,
  BAIZE_ROOT: baizeRoot,
  SHALLOW_MEMORY_DIR: path.join(baizeRoot, 'memory', 'shallow'),
  DEEP_INDEX_DIR: path.join(baizeRoot, 'memory', 'deep', 'indexes'),
  LOGIC_ASSERTIONS_DIR: path.join(baizeRoot, 'logic', 'assertions'),
  GLOBAL_MD: path.join(baizeRoot, 'config', 'global.md'),
  GLOBAL_YAML: path.join(baizeRoot, 'config', 'global.yaml')
};

module.exports = paths;
```

- [ ] **Step 4: Write `src/lib/response.js`**

```js
function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}

function notImplemented() {
  return ok({
    implemented: false,
    message: 'Phase 1 only reserves this plugin interface.'
  });
}

module.exports = {
  ok,
  fail,
  notImplemented
};
```

- [ ] **Step 5: Write `src/lib/markdown.js`**

```js
function timestamp(now = new Date()) {
  return now.toISOString();
}

function formatShallowMemoryEntry({ content, source = 'manual', now }) {
  return `\n## ${timestamp(now)}\n\n- 来源：${source}\n- 内容：${content}\n`;
}

function formatDeepIndexRow({ title, path, tags = [], summary, now }) {
  const tagText = Array.isArray(tags) ? tags.join(', ') : '';
  return `| ${title} | ${path} | ${tagText} | ${summary} | ${timestamp(now)} |\n`;
}

function formatLogicAssertionEntry({ statement, source = 'manual', now }) {
  return `\n## ${timestamp(now)}\n\n- 来源：${source}\n- 断言：${statement}\n`;
}

function formatLogicDraftEntry({ category, statement, source = 'passive_detected', now }) {
  return `\n## ${timestamp(now)}\n\n- 分类：${category}\n- 来源：${source}\n- 待确认断言：${statement}\n`;
}

module.exports = {
  formatShallowMemoryEntry,
  formatDeepIndexRow,
  formatLogicAssertionEntry,
  formatLogicDraftEntry
};
```

- [ ] **Step 6: Write `src/lib/file-store.js`**

```js
const fs = require('fs/promises');
const path = require('path');

function ensureInside(targetPath, allowedRoot) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(allowedRoot);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    const error = new Error('Path is outside allowed root.');
    error.code = 'PATH_OUTSIDE_ALLOWED_ROOT';
    throw error;
  }

  return resolvedTarget;
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function appendText(filePath, content, allowedRoot) {
  const target = ensureInside(filePath, allowedRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, content, 'utf8');
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ensureInside,
  readText,
  appendText,
  exists
};
```

- [ ] **Step 7: Run tests to establish baseline**

Run:

```bash
npm test
```

Expected: exits with code 1 or reports no tests found, because test files are not created yet.

---

## Task 2: Add config service and health/config APIs

**Files:**
- Create: `src/services/config-service.js`
- Create: `src/routes/health.routes.js`
- Create: `src/routes/config.routes.js`
- Create: `src/app.js`
- Create: `src/server.js`
- Create: `tests/api.test.js`

- [ ] **Step 1: Write failing API tests**

```js
const request = require('supertest');
const { createApp } = require('../src/app');

describe('baize local hub API', () => {
  it('returns health status', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      service: 'baize-local-hub',
      phase: '1'
    });
  });

  it('returns global config markdown and parsed yaml', async () => {
    const app = createApp();

    const response = await request(app).get('/config/global');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.markdown).toContain('白泽全局设定');
    expect(response.body.data.config.system.name).toBe('白泽');
    expect(response.body.data.config.system.nickname).toBe('小泽');
  });

  it('returns json 404 for unknown routes', async () => {
    const app = createApp();

    const response = await request(app).get('/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.'
      }
    });
  });
});
```

- [ ] **Step 2: Run failing API tests**

Run:

```bash
npm test -- tests/api.test.js
```

Expected: fails because `src/app.js` does not exist yet.

- [ ] **Step 3: Write `src/services/config-service.js`**

```js
const YAML = require('yaml');
const paths = require('../config/paths');
const { readText } = require('../lib/file-store');

async function getGlobalConfig() {
  const [markdown, yamlText] = await Promise.all([
    readText(paths.GLOBAL_MD),
    readText(paths.GLOBAL_YAML)
  ]);

  return {
    markdown,
    config: YAML.parse(yamlText)
  };
}

module.exports = {
  getGlobalConfig
};
```

- [ ] **Step 4: Write `src/routes/health.routes.js`**

```js
const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'baize-local-hub',
    phase: '1'
  });
});

module.exports = router;
```

- [ ] **Step 5: Write `src/routes/config.routes.js`**

```js
const express = require('express');
const { getGlobalConfig } = require('../services/config-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.get('/config/global', async (req, res, next) => {
  try {
    res.json(ok(await getGlobalConfig()));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

- [ ] **Step 6: Write `src/app.js`**

```js
const express = require('express');
const healthRoutes = require('./routes/health.routes');
const configRoutes = require('./routes/config.routes');
const { fail } = require('./lib/response');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(healthRoutes);
  app.use(configRoutes);

  app.use((req, res) => {
    res.status(404).json(fail('NOT_FOUND', 'Route not found.'));
  });

  app.use((error, req, res, next) => {
    const status = error.statusCode || 500;
    const code = error.code || 'INTERNAL_ERROR';
    const message = error.publicMessage || error.message || 'Internal server error.';
    res.status(status).json(fail(code, message));
  });

  return app;
}

module.exports = {
  createApp
};
```

- [ ] **Step 7: Write `src/server.js`**

```js
const { createApp } = require('./app');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(port, host, () => {
  console.log(`baize-local-hub listening at http://${host}:${port}`);
});
```

- [ ] **Step 8: Run API tests**

Run:

```bash
npm test -- tests/api.test.js
```

Expected: all 3 tests pass.

---

## Task 3: Implement memory service with tests

**Files:**
- Create: `tests/helpers/test-root.js`
- Create: `tests/memory-service.test.js`
- Create: `src/services/memory-service.js`

- [ ] **Step 1: Write test helper**

```js
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function createTestRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-test-'));
  const baizeRoot = path.join(root, 'baize');

  await fs.mkdir(path.join(baizeRoot, 'memory', 'shallow'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'indexes'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project'), { recursive: true });

  const shallowFiles = ['programming', 'design', 'art', 'general', 'pm', 'project'];
  for (const category of shallowFiles) {
    await fs.writeFile(
      path.join(baizeRoot, 'memory', 'shallow', `${category}.md`),
      `# ${category}\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(baizeRoot, 'memory', 'deep', 'indexes', `${category}-index.md`),
      '# Index\n\n| 标题 | 路径 | 标签 | 摘要 | 更新时间 |\n|---|---|---|---|---|\n',
      'utf8'
    );
  }

  return { root, baizeRoot };
}

module.exports = {
  createTestRoot
};
```

- [ ] **Step 2: Write failing memory service tests**

```js
const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const {
  addShallowMemory,
  searchShallowMemory,
  addDeepMemoryIndex
} = require('../src/services/memory-service');

describe('memory service', () => {
  it('appends shallow memory without overwriting existing content', async () => {
    const { baizeRoot } = await createTestRoot();

    const result = await addShallowMemory({
      baizeRoot,
      category: 'design',
      content: '角色设计优先考虑移动端单手操作。',
      source: 'manual',
      now: new Date('2026-05-19T10:00:00.000Z')
    });

    const fileText = await fs.readFile(result.file, 'utf8');
    expect(fileText).toContain('# design');
    expect(fileText).toContain('## 2026-05-19T10:00:00.000Z');
    expect(fileText).toContain('- 来源：manual');
    expect(fileText).toContain('- 内容：角色设计优先考虑移动端单手操作。');
  });

  it('searches shallow memory by category and keyword', async () => {
    const { baizeRoot } = await createTestRoot();
    await addShallowMemory({
      baizeRoot,
      category: 'design',
      content: '角色设计优先考虑移动端单手操作。',
      source: 'manual',
      now: new Date('2026-05-19T10:00:00.000Z')
    });

    const results = await searchShallowMemory({ baizeRoot, category: 'design', q: '角色' });

    expect(results).toEqual([
      expect.objectContaining({
        category: 'design',
        line: '- 内容：角色设计优先考虑移动端单手操作。'
      })
    ]);
  });

  it('rejects unsupported memory categories', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(addShallowMemory({
      baizeRoot,
      category: 'unknown',
      content: 'x'
    })).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  });

  it('appends deep memory index and reports missing path', async () => {
    const { baizeRoot } = await createTestRoot();
    const missingPath = path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project', 'meeting-001.md');

    const result = await addDeepMemoryIndex({
      baizeRoot,
      category: 'project',
      title: '第一次项目方向讨论',
      path: missingPath,
      tags: ['方向', '会议'],
      summary: '确认项目智能中枢白泽的长期方向。',
      now: new Date('2026-05-19T10:00:00.000Z')
    });

    const indexText = await fs.readFile(result.indexFile, 'utf8');
    expect(result.pathExists).toBe(false);
    expect(indexText).toContain('| 第一次项目方向讨论 |');
    expect(indexText).toContain('| 方向, 会议 |');
  });
});
```

- [ ] **Step 3: Run failing memory service tests**

Run:

```bash
npm test -- tests/memory-service.test.js
```

Expected: fails because `src/services/memory-service.js` does not exist yet.

- [ ] **Step 4: Write `src/services/memory-service.js`**

```js
const path = require('path');
const paths = require('../config/paths');
const { appendText, exists, readText } = require('../lib/file-store');
const { formatDeepIndexRow, formatShallowMemoryEntry } = require('../lib/markdown');

const MEMORY_CATEGORIES = ['programming', 'design', 'art', 'general', 'pm', 'project'];

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function assertMemoryCategory(category) {
  if (!MEMORY_CATEGORIES.includes(category)) {
    throw validationError('INVALID_CATEGORY', 'Unsupported category.');
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError('VALIDATION_ERROR', `${field} is required.`);
  }
}

function resolvePaths(baizeRoot = paths.BAIZE_ROOT) {
  return {
    shallowDir: path.join(baizeRoot, 'memory', 'shallow'),
    deepIndexDir: path.join(baizeRoot, 'memory', 'deep', 'indexes')
  };
}

async function addShallowMemory({ baizeRoot, category, content, source = 'manual', now }) {
  assertMemoryCategory(category);
  requireText(content, 'content');

  const { shallowDir } = resolvePaths(baizeRoot);
  const file = path.join(shallowDir, `${category}.md`);
  await appendText(file, formatShallowMemoryEntry({ content, source, now }), shallowDir);

  return { category, file };
}

async function searchShallowMemory({ baizeRoot, category, q } = {}) {
  if (category) {
    assertMemoryCategory(category);
  }

  const { shallowDir } = resolvePaths(baizeRoot);
  const categories = category ? [category] : MEMORY_CATEGORIES;
  const results = [];

  for (const currentCategory of categories) {
    const file = path.join(shallowDir, `${currentCategory}.md`);
    const text = await readText(file);
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      if (!q || line.includes(q)) {
        results.push({ category: currentCategory, file, line });
      }
    }
  }

  return results.filter((result) => result.line.trim() !== '');
}

async function addDeepMemoryIndex({ baizeRoot, category, title, path: memoryPath, tags = [], summary, now }) {
  assertMemoryCategory(category);
  requireText(title, 'title');
  requireText(memoryPath, 'path');
  requireText(summary, 'summary');

  const { deepIndexDir } = resolvePaths(baizeRoot);
  const indexFile = path.join(deepIndexDir, `${category}-index.md`);
  const pathExists = await exists(memoryPath);

  await appendText(indexFile, formatDeepIndexRow({ title, path: memoryPath, tags, summary, now }), deepIndexDir);

  return { category, indexFile, pathExists };
}

module.exports = {
  MEMORY_CATEGORIES,
  addShallowMemory,
  searchShallowMemory,
  addDeepMemoryIndex
};
```

- [ ] **Step 5: Run memory service tests**

Run:

```bash
npm test -- tests/memory-service.test.js
```

Expected: all memory service tests pass.

---

## Task 4: Implement logic service with tests

**Files:**
- Modify: `tests/helpers/test-root.js`
- Create: `tests/logic-service.test.js`
- Create: `src/services/logic-service.js`

- [ ] **Step 1: Update test helper for logic files**

Replace `tests/helpers/test-root.js` with:

```js
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function createTestRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-test-'));
  const baizeRoot = path.join(root, 'baize');

  await fs.mkdir(path.join(baizeRoot, 'memory', 'shallow'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'indexes'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'logic', 'assertions'), { recursive: true });

  const memoryCategories = ['programming', 'design', 'art', 'general', 'pm', 'project'];
  for (const category of memoryCategories) {
    await fs.writeFile(path.join(baizeRoot, 'memory', 'shallow', `${category}.md`), `# ${category}\n`, 'utf8');
    await fs.writeFile(
      path.join(baizeRoot, 'memory', 'deep', 'indexes', `${category}-index.md`),
      '# Index\n\n| 标题 | 路径 | 标签 | 摘要 | 更新时间 |\n|---|---|---|---|---|\n',
      'utf8'
    );
  }

  const logicCategories = ['programming', 'design', 'art', 'general', 'pm', 'project', 'identity'];
  for (const category of logicCategories) {
    await fs.writeFile(path.join(baizeRoot, 'logic', 'assertions', `${category}.md`), `# ${category}\n`, 'utf8');
  }

  return { root, baizeRoot };
}

module.exports = {
  createTestRoot
};
```

- [ ] **Step 2: Write failing logic service tests**

```js
const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const { submitLogicAssertion } = require('../src/services/logic-service');

describe('logic service', () => {
  it('writes passive detected assertions to drafts and requires confirmation', async () => {
    const { baizeRoot } = await createTestRoot();

    const result = await submitLogicAssertion({
      baizeRoot,
      category: 'design',
      statement: '角色设计优先考虑移动端单手操作。',
      source: 'passive_detected',
      now: new Date('2026-05-19T10:00:00.000Z')
    });

    const text = await fs.readFile(result.file, 'utf8');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.file).toBe(path.join(baizeRoot, 'logic', 'assertions', 'drafts.md'));
    expect(text).toContain('- 分类：design');
    expect(text).toContain('- 来源：passive_detected');
    expect(text).toContain('- 待确认断言：角色设计优先考虑移动端单手操作。');
  });

  it('writes manual assertions to the formal category file', async () => {
    const { baizeRoot } = await createTestRoot();

    const result = await submitLogicAssertion({
      baizeRoot,
      category: 'design',
      statement: '角色设计优先考虑移动端单手操作。',
      source: 'manual',
      now: new Date('2026-05-19T10:00:00.000Z')
    });

    const text = await fs.readFile(result.file, 'utf8');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.file).toBe(path.join(baizeRoot, 'logic', 'assertions', 'design.md'));
    expect(text).toContain('- 来源：manual');
    expect(text).toContain('- 断言：角色设计优先考虑移动端单手操作。');
  });

  it('rejects unsupported logic categories', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(submitLogicAssertion({
      baizeRoot,
      category: 'unknown',
      statement: 'x'
    })).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  });
});
```

- [ ] **Step 3: Run failing logic tests**

Run:

```bash
npm test -- tests/logic-service.test.js
```

Expected: fails because `src/services/logic-service.js` does not exist yet.

- [ ] **Step 4: Write `src/services/logic-service.js`**

```js
const path = require('path');
const paths = require('../config/paths');
const { appendText } = require('../lib/file-store');
const { formatLogicAssertionEntry, formatLogicDraftEntry } = require('../lib/markdown');

const LOGIC_CATEGORIES = ['programming', 'design', 'art', 'general', 'pm', 'project', 'identity'];

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function assertLogicCategory(category) {
  if (!LOGIC_CATEGORIES.includes(category)) {
    throw validationError('INVALID_CATEGORY', 'Unsupported category.');
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError('VALIDATION_ERROR', `${field} is required.`);
  }
}

async function submitLogicAssertion({ baizeRoot = paths.BAIZE_ROOT, category, statement, source = 'passive_detected', now }) {
  assertLogicCategory(category);
  requireText(statement, 'statement');

  const assertionsDir = path.join(baizeRoot, 'logic', 'assertions');

  if (source === 'manual') {
    const file = path.join(assertionsDir, `${category}.md`);
    await appendText(file, formatLogicAssertionEntry({ statement, source, now }), assertionsDir);
    return { category, requiresConfirmation: false, file };
  }

  const file = path.join(assertionsDir, 'drafts.md');
  await appendText(file, formatLogicDraftEntry({ category, statement, source, now }), assertionsDir);
  return { category, requiresConfirmation: true, file };
}

module.exports = {
  LOGIC_CATEGORIES,
  submitLogicAssertion
};
```

- [ ] **Step 5: Run logic service tests**

Run:

```bash
npm test -- tests/logic-service.test.js
```

Expected: all logic service tests pass.

---

## Task 5: Add memory and logic API routes

**Files:**
- Create: `src/routes/memory.routes.js`
- Create: `src/routes/logic.routes.js`
- Modify: `src/app.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Replace `tests/api.test.js` with API coverage**

```js
const request = require('supertest');
const { createApp } = require('../src/app');

describe('baize local hub API', () => {
  it('returns health status', async () => {
    const app = createApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, service: 'baize-local-hub', phase: '1' });
  });

  it('returns global config markdown and parsed yaml', async () => {
    const app = createApp();
    const response = await request(app).get('/config/global');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.markdown).toContain('白泽全局设定');
    expect(response.body.data.config.system.name).toBe('白泽');
  });

  it('writes shallow memory through the API', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/memory/shallow')
      .send({ category: 'general', content: 'API 写入测试。', source: 'manual' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.category).toBe('general');
    expect(response.body.data.file).toContain('general.md');
  });

  it('searches shallow memory through the API', async () => {
    const app = createApp();
    await request(app)
      .post('/memory/shallow')
      .send({ category: 'general', content: 'API 查询测试。', source: 'manual' });

    const response = await request(app).get('/memory/shallow?category=general&q=API 查询');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.results.some((result) => result.line.includes('API 查询测试'))).toBe(true);
  });

  it('adds deep memory index through the API', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/memory/deep/index')
      .send({
        category: 'project',
        title: 'API 深层索引测试',
        path: 'G:/Robot/baize/memory/deep/partitions/project/api-test.md',
        tags: ['API', '测试'],
        summary: '通过 API 登记深层记忆索引。'
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.category).toBe('project');
    expect(response.body.data.pathExists).toBe(false);
  });

  it('submits passive logic assertion drafts through the API', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/logic/assertions/draft')
      .send({ category: 'design', statement: 'API 被动逻辑草案测试。', source: 'passive_detected' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.requiresConfirmation).toBe(true);
    expect(response.body.data.file).toContain('drafts.md');
  });

  it('returns invalid category errors as json', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/memory/shallow')
      .send({ category: 'unknown', content: 'x' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'INVALID_CATEGORY', message: 'Unsupported category.' }
    });
  });

  it('returns validation errors as json', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/memory/shallow')
      .send({ category: 'general' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'content is required.' }
    });
  });

  it('returns json 404 for unknown routes', async () => {
    const app = createApp();
    const response = await request(app).get('/missing');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
});
```

- [ ] **Step 2: Run failing API tests**

Run:

```bash
npm test -- tests/api.test.js
```

Expected: fails because memory and logic routes are not registered yet.

- [ ] **Step 3: Write `src/routes/memory.routes.js`**

```js
const express = require('express');
const { ok } = require('../lib/response');
const { addDeepMemoryIndex, addShallowMemory, searchShallowMemory } = require('../services/memory-service');

const router = express.Router();

router.post('/memory/shallow', async (req, res, next) => {
  try {
    res.json(ok(await addShallowMemory(req.body)));
  } catch (error) {
    next(error);
  }
});

router.get('/memory/shallow', async (req, res, next) => {
  try {
    const { category, q } = req.query;
    res.json(ok({ results: await searchShallowMemory({ category, q }) }));
  } catch (error) {
    next(error);
  }
});

router.post('/memory/deep/index', async (req, res, next) => {
  try {
    res.json(ok(await addDeepMemoryIndex(req.body)));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

- [ ] **Step 4: Write `src/routes/logic.routes.js`**

```js
const express = require('express');
const { ok } = require('../lib/response');
const { submitLogicAssertion } = require('../services/logic-service');

const router = express.Router();

router.post('/logic/assertions/draft', async (req, res, next) => {
  try {
    res.json(ok(await submitLogicAssertion(req.body)));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

- [ ] **Step 5: Update `src/app.js`**

Replace `src/app.js` with:

```js
const express = require('express');
const healthRoutes = require('./routes/health.routes');
const configRoutes = require('./routes/config.routes');
const memoryRoutes = require('./routes/memory.routes');
const logicRoutes = require('./routes/logic.routes');
const { fail } = require('./lib/response');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(healthRoutes);
  app.use(configRoutes);
  app.use(memoryRoutes);
  app.use(logicRoutes);

  app.use((req, res) => {
    res.status(404).json(fail('NOT_FOUND', 'Route not found.'));
  });

  app.use((error, req, res, next) => {
    const status = error.statusCode || 500;
    const code = error.code || 'INTERNAL_ERROR';
    const message = error.publicMessage || error.message || 'Internal server error.';
    res.status(status).json(fail(code, message));
  });

  return app;
}

module.exports = {
  createApp
};
```

- [ ] **Step 6: Run API tests**

Run:

```bash
npm test -- tests/api.test.js
```

Expected: API tests pass.

---

## Task 6: Add plugin placeholder APIs

**Files:**
- Create: `src/services/plugin-service.js`
- Create: `src/routes/plugins.routes.js`
- Modify: `src/app.js`
- Modify: `tests/api.test.js`

- [ ] **Step 1: Add plugin API tests to `tests/api.test.js`**

Append these tests inside the existing `describe('baize local hub API', () => { ... })` block:

```js
  it('returns placeholder response for WeCom webhook', async () => {
    const app = createApp();
    const response = await request(app).post('/plugins/wecom/webhook').send({ text: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        implemented: false,
        message: 'Phase 1 only reserves this plugin interface.'
      }
    });
  });

  it('returns placeholder response for Jira status', async () => {
    const app = createApp();
    const response = await request(app).get('/plugins/jira/status');

    expect(response.status).toBe(200);
    expect(response.body.data.implemented).toBe(false);
  });

  it('returns placeholder response for knowledge base status', async () => {
    const app = createApp();
    const response = await request(app).get('/plugins/knowledge-base/status');

    expect(response.status).toBe(200);
    expect(response.body.data.implemented).toBe(false);
  });
```

- [ ] **Step 2: Run failing plugin API tests**

Run:

```bash
npm test -- tests/api.test.js
```

Expected: fails because plugin routes are not registered yet.

- [ ] **Step 3: Write `src/services/plugin-service.js`**

```js
function pluginPlaceholder() {
  return {
    implemented: false,
    message: 'Phase 1 only reserves this plugin interface.'
  };
}

module.exports = {
  pluginPlaceholder
};
```

- [ ] **Step 4: Write `src/routes/plugins.routes.js`**

```js
const express = require('express');
const { ok } = require('../lib/response');
const { pluginPlaceholder } = require('../services/plugin-service');

const router = express.Router();

router.post('/plugins/wecom/webhook', (req, res) => {
  res.json(ok(pluginPlaceholder()));
});

router.get('/plugins/jira/status', (req, res) => {
  res.json(ok(pluginPlaceholder()));
});

router.get('/plugins/knowledge-base/status', (req, res) => {
  res.json(ok(pluginPlaceholder()));
});

module.exports = router;
```

- [ ] **Step 5: Update `src/app.js` to register plugin routes**

Replace `src/app.js` with:

```js
const express = require('express');
const healthRoutes = require('./routes/health.routes');
const configRoutes = require('./routes/config.routes');
const memoryRoutes = require('./routes/memory.routes');
const logicRoutes = require('./routes/logic.routes');
const pluginRoutes = require('./routes/plugins.routes');
const { fail } = require('./lib/response');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(healthRoutes);
  app.use(configRoutes);
  app.use(memoryRoutes);
  app.use(logicRoutes);
  app.use(pluginRoutes);

  app.use((req, res) => {
    res.status(404).json(fail('NOT_FOUND', 'Route not found.'));
  });

  app.use((error, req, res, next) => {
    const status = error.statusCode || 500;
    const code = error.code || 'INTERNAL_ERROR';
    const message = error.publicMessage || error.message || 'Internal server error.';
    res.status(status).json(fail(code, message));
  });

  return app;
}

module.exports = {
  createApp
};
```

- [ ] **Step 6: Run API tests**

Run:

```bash
npm test -- tests/api.test.js
```

Expected: API tests pass.

---

## Task 7: Final verification

**Files:**
- Verify all Phase 1 files.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 2: Start local server manually**

Run:

```bash
npm start
```

Expected: output includes:

```text
baize-local-hub listening at http://127.0.0.1:3000
```

Stop the process with Ctrl+C after confirming startup.

- [ ] **Step 3: Verify no real integration URLs or secrets were introduced**

Run:

```bash
python - <<'PY'
from pathlib import Path
patterns = ['http://', 'https://', 'Bearer ', 'api_key', 'token:', 'password:', 'secret:']
for path in list(Path('src').rglob('*')) + list(Path('tests').rglob('*')):
    if path.is_file():
        text = path.read_text(encoding='utf-8')
        for pattern in patterns:
            assert pattern not in text, f'{pattern} found in {path}'
print('no real integration urls or secrets found')
PY
```

Expected: prints `no real integration urls or secrets found`.

- [ ] **Step 4: Check git availability**

Run:

```bash
git status --short
```

Expected in current environment: `fatal: not a git repository (or any of the parent directories): .git`.

If the directory is not a git repository, do not create a commit.

---

## Self-Review

- Spec coverage: Tasks cover Express startup, health check, global config reading, shallow memory write/search, deep index registration, logic assertion draft/manual write, plugin placeholders, local-only safety boundary, and tests.
- Placeholder scan: The plan contains no unresolved markers, no incomplete file contents, and no unspecified file paths.
- Scope check: The plan does not implement real Enterprise WeChat, Jira, knowledge-base integrations, database, vector search, deletion, overwrite, batch modification, or public deployment.
- Type consistency: Function names, route paths, response shapes, category names, and file paths are consistent across tests, routes, services, and the spec.
