# 白泽 Phase 1 本地服务设计文档

## 1. 背景

Phase 0 已完成白泽项目智能中枢的文件骨架、配置、记忆分区、逻辑分区、插件声明和运行机制文档。Phase 1 的目标是让白泽从静态文件骨架变成一个本地可调用的服务。

Phase 1 采用 Node.js + Express。本阶段只操作 `G:\Robot\baize` 下的本地 Markdown/YAML 文件，不接入真实企业微信、Jira、项目知识库，不引入数据库，不执行破坏性操作。

## 2. 目标

Phase 1 建立一个本地 Express 服务，提供最小可用的知识中枢能力：

- 启动本地 Express 服务。
- 提供健康检查接口。
- 读取全局配置。
- 写入浅层记忆。
- 查询浅层记忆。
- 登记深层记忆索引。
- 提交逻辑断言草案。
- 预留企业微信、Jira、项目知识库插件接口。

## 3. 非目标

Phase 1 不做：

- 不接真实企业微信。
- 不接真实 Jira。
- 不接真实项目知识库。
- 不做数据库。
- 不做向量检索。
- 不做复杂权限系统。
- 不执行删除、覆盖、批量修改等敏感操作。
- 不做公网部署。

## 4. 推荐目录结构

```text
G:\Robot\
├─ package.json
├─ src\
│  ├─ server.js
│  ├─ app.js
│  ├─ config\
│  │  └─ paths.js
│  ├─ lib\
│  │  ├─ file-store.js
│  │  ├─ markdown.js
│  │  └─ response.js
│  ├─ routes\
│  │  ├─ health.routes.js
│  │  ├─ config.routes.js
│  │  ├─ memory.routes.js
│  │  ├─ logic.routes.js
│  │  └─ plugins.routes.js
│  └─ services\
│     ├─ config-service.js
│     ├─ memory-service.js
│     ├─ logic-service.js
│     └─ plugin-service.js
└─ tests\
   ├─ memory-service.test.js
   ├─ logic-service.test.js
   └─ api.test.js
```

## 5. 服务边界

本地服务只读写 `G:\Robot\baize` 下的文件。

服务不直接暴露内部子智能体。接口命名可以体现 memory、logic、plugins 等领域，但对使用者而言仍是白泽本地中枢服务。

所有接口使用 JSON 请求和 JSON 响应。错误响应也统一使用 JSON。

## 6. 模块设计

### 6.1 `src/server.js`

职责：

- 读取端口配置。
- 启动 Express 应用。
- 输出本地启动信息。

默认监听：

```text
127.0.0.1:3000
```

### 6.2 `src/app.js`

职责：

- 创建 Express app。
- 启用 JSON body parser。
- 注册路由。
- 注册统一 404 和错误响应。

### 6.3 `src/config/paths.js`

职责：

- 集中定义 `G:\Robot\baize` 相关路径。
- 支持通过环境变量覆盖根路径，默认仍为当前项目路径。

核心路径：

```js
BAIZE_ROOT = "G:/Robot/baize"
SHALLOW_MEMORY_DIR = "G:/Robot/baize/memory/shallow"
DEEP_INDEX_DIR = "G:/Robot/baize/memory/deep/indexes"
LOGIC_ASSERTIONS_DIR = "G:/Robot/baize/logic/assertions"
GLOBAL_MD = "G:/Robot/baize/config/global.md"
GLOBAL_YAML = "G:/Robot/baize/config/global.yaml"
```

### 6.4 `src/lib/file-store.js`

职责：

- 安全读取文本文件。
- 追加文本到文件。
- 判断路径是否存在。
- 限制写入目标只能落在允许目录下。

### 6.5 `src/lib/markdown.js`

职责：

- 格式化浅层记忆条目。
- 格式化深层记忆索引行。
- 格式化逻辑断言草案条目。

### 6.6 `src/lib/response.js`

职责：

- 统一成功响应。
- 统一失败响应。
- 统一未实现响应。

### 6.7 `src/services/config-service.js`

职责：

- 读取 `global.md` 原文。
- 读取并解析 `global.yaml`。
- 返回组合后的全局配置。

### 6.8 `src/services/memory-service.js`

职责：

- 校验记忆分类。
- 追加浅层记忆。
- 查询浅层记忆。
- 登记深层记忆索引。

支持分类：

```text
programming
design
art
general
pm
project
```

### 6.9 `src/services/logic-service.js`

职责：

- 校验逻辑分类。
- 写入主动设置的逻辑断言。
- 将被动发现的逻辑断言写入草案。
- 返回是否需要用户确认。

支持分类：

```text
programming
design
art
general
pm
project
identity
```

新增草案文件：

```text
G:\Robot\baize\logic\assertions\drafts.md
```

### 6.10 `src/services/plugin-service.js`

职责：

- 返回企业微信、Jira、项目知识库插件占位状态。
- 明确 Phase 1 只预留接口，不执行真实外部调用。

## 7. API 设计

### 7.1 健康检查

```http
GET /health
```

响应：

```json
{
  "ok": true,
  "service": "baize-local-hub",
  "phase": "1"
}
```

### 7.2 读取全局配置

```http
GET /config/global
```

响应：

```json
{
  "ok": true,
  "data": {
    "markdown": "# 白泽全局设定...",
    "config": {
      "system": {
        "name": "白泽",
        "nickname": "小泽"
      }
    }
  }
}
```

### 7.3 写入浅层记忆

```http
POST /memory/shallow
```

请求：

```json
{
  "category": "design",
  "content": "角色设计优先考虑移动端单手操作。",
  "source": "manual"
}
```

规则：

- `category` 必须是六类记忆之一。
- `content` 不能为空。
- `source` 可选，默认 `manual`。
- 只追加，不覆盖。
- 写入格式包含时间、来源、内容。

响应：

```json
{
  "ok": true,
  "data": {
    "category": "design",
    "file": "G:/Robot/baize/memory/shallow/design.md"
  }
}
```

### 7.4 查询浅层记忆

```http
GET /memory/shallow?category=design&q=角色
```

规则：

- `category` 可选。
- 不传 `category` 时查询全部浅层记忆。
- `q` 可选。
- `q` 使用简单文本包含匹配。

响应：

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "category": "design",
        "file": "G:/Robot/baize/memory/shallow/design.md",
        "line": "- 2026-05-19...角色设计优先考虑移动端单手操作。"
      }
    ]
  }
}
```

### 7.5 登记深层记忆索引

```http
POST /memory/deep/index
```

请求：

```json
{
  "category": "project",
  "title": "第一次项目方向讨论",
  "path": "G:/Robot/baize/memory/deep/partitions/project/meeting-001.md",
  "tags": ["方向", "会议"],
  "summary": "确认项目智能中枢白泽的长期方向。"
}
```

规则：

- `category` 必须是六类记忆之一。
- `title`、`path`、`summary` 不能为空。
- `tags` 可为空数组。
- 不复制大文件。
- 只向对应 `*-index.md` 追加一行索引。
- 如果 `path` 不存在，仍允许登记，但返回 `pathExists: false`。

响应：

```json
{
  "ok": true,
  "data": {
    "category": "project",
    "indexFile": "G:/Robot/baize/memory/deep/indexes/project-index.md",
    "pathExists": false
  }
}
```

### 7.6 提交逻辑断言草案

```http
POST /logic/assertions/draft
```

请求：

```json
{
  "category": "design",
  "statement": "角色设计优先考虑移动端单手操作。",
  "source": "passive_detected"
}
```

规则：

- `category` 必须是七类逻辑之一。
- `statement` 不能为空。
- `source` 可选，默认 `passive_detected`。
- `source=manual` 时，写入对应正式逻辑断言文件。
- `source=passive_detected` 时，写入 `drafts.md`，并返回 `requiresConfirmation: true`。

响应：

```json
{
  "ok": true,
  "data": {
    "category": "design",
    "requiresConfirmation": true,
    "file": "G:/Robot/baize/logic/assertions/drafts.md"
  }
}
```

### 7.7 插件占位接口

```http
POST /plugins/wecom/webhook
GET /plugins/jira/status
GET /plugins/knowledge-base/status
```

响应：

```json
{
  "ok": true,
  "data": {
    "implemented": false,
    "message": "Phase 1 only reserves this plugin interface."
  }
}
```

## 8. 数据写入格式

### 8.1 浅层记忆追加格式

```md

## 2026-05-19T10:00:00.000Z

- 来源：manual
- 内容：角色设计优先考虑移动端单手操作。
```

### 8.2 深层记忆索引追加格式

```md
| 第一次项目方向讨论 | G:/Robot/baize/memory/deep/partitions/project/meeting-001.md | 方向, 会议 | 确认项目智能中枢白泽的长期方向。 | 2026-05-19T10:00:00.000Z |
```

### 8.3 逻辑断言追加格式

```md

## 2026-05-19T10:00:00.000Z

- 来源：manual
- 断言：角色设计优先考虑移动端单手操作。
```

### 8.4 被动逻辑草案追加格式

```md

## 2026-05-19T10:00:00.000Z

- 分类：design
- 来源：passive_detected
- 待确认断言：角色设计优先考虑移动端单手操作。
```

## 9. 校验与错误处理

### 9.1 分类校验

无效分类返回：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_CATEGORY",
    "message": "Unsupported category."
  }
}
```

### 9.2 必填字段校验

缺少必填字段返回：

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "content is required."
  }
}
```

### 9.3 未实现能力

插件占位能力返回：

```json
{
  "ok": true,
  "data": {
    "implemented": false,
    "message": "Phase 1 only reserves this plugin interface."
  }
}
```

## 10. 安全边界

- 服务默认只监听 `127.0.0.1`。
- 只允许写入白泽允许的本地目录。
- 不接受删除文件请求。
- 不接受覆盖文件请求。
- 不读取或写入凭据。
- 不连接真实企业微信、Jira、项目知识库。
- 插件接口只返回占位响应。

## 11. 测试策略

建议使用 Vitest 和 Supertest。

测试覆盖：

- 健康检查返回 Phase 1 信息。
- 全局配置接口能读取 Markdown 和 YAML。
- 浅层记忆写入会追加内容，不覆盖原文件。
- 浅层记忆查询支持分类和关键词。
- 深层记忆索引登记会追加表格行。
- 深层记忆索引登记在路径不存在时返回 `pathExists: false`。
- 被动逻辑断言写入 `drafts.md` 并返回 `requiresConfirmation: true`。
- 主动逻辑断言写入正式分类文件。
- 插件占位接口返回 `implemented: false`。
- 无效分类返回 `INVALID_CATEGORY`。
- 缺少必填字段返回 `VALIDATION_ERROR`。

## 12. 验收标准

Phase 1 完成时应满足：

- `npm test` 通过。
- 本地服务可以启动。
- `GET /health` 返回成功。
- 能通过 API 写入和查询浅层记忆。
- 能通过 API 登记深层记忆索引。
- 能通过 API 提交被动逻辑断言草案。
- 插件占位接口存在但不访问外部系统。
- 不产生任何真实企业微信/Jira/知识库调用。
