# 白泽项目智能中枢设计文档

## 1. 背景与目标

白泽是当前项目的“大总管”机器人，小名小泽。它不是普通聊天机器人，而是面向长期项目管理、项目知识沉淀、逻辑规则维护、任务统计和外部系统集成的项目智能中枢。

第一轮设计目标是建立长期架构，而不是立即完成全部功能实现。本设计先定义目录结构、分区职责、内部子智能体、记忆系统、逻辑系统、插件系统、审计机制和演进路线。

当前所有分区和文件都存储在 `G:\Robot` 下。

## 2. 白泽/小泽身份设定

- 正式名称：白泽。
- 小名：小泽。
- 默认回复语言：中文。
- 项目定位：项目智能中枢。
- 对外人格：用户只看到统一的白泽/小泽，不直接看到内部子智能体。
- 项目背景：当前项目是一个类似荒野乱斗的项目。

## 3. 总体架构

```text
用户
 │
 ▼
统一入口层
  - 企业微信机器人
  - CLI / Web / API 预留
 │
 ▼
白泽主控层
  - 统一人格：白泽 / 小泽
  - 全局设定：中文回复、项目背景、权限边界、默认行为
  - 意图识别：判断用户是在问记忆、任务、逻辑、集成、审计
  - 子智能体调度：选择内部子智能体处理
 │
 ├─ 记忆官：管理浅层记忆、深层记忆、索引、归档
 ├─ 逻辑官：管理项目断言、判断规则、世界观/身份规则
 ├─ 任务官：管理 Jira、待办、统计、周报、进度追踪
 ├─ 集成官：管理企业微信、Jira、知识库等插件接入
 └─ 审计官：管理权限、安全、变更记录、敏感操作确认
 │
 ▼
插件层
  - 企业微信插件
  - Jira Software 插件
  - 项目知识库插件
  - 后续 Git、CI、文档、日历等插件
 │
 ▼
存储层
  - 浅层记忆：项目内 Markdown
  - 深层记忆：抽象存储接口，当前落地到 G:\Robot 下的本地路径
  - 逻辑分区：Markdown 解释层 + YAML/JSON 执行层
  - 技能分区：插件说明、调用配置、能力声明
  - 基础设定：全局设定 + 子智能体独立设定
```

关键原则：

- 外部单一人格：用户只看到白泽/小泽。
- 内部多智能体协作：子智能体只在内部使用。
- 插件化接入外部系统：企业微信、Jira、项目知识库都是插件。
- 配置分层：全局设置约束所有行为，子智能体设置定义各自职责。
- 长期可扩展：当前使用本地路径，未来可替换为 NAS、对象存储或数据库。

## 4. 目录结构

```text
G:\Robot\
├─ baize\
│  ├─ README.md
│  ├─ config\
│  │  ├─ global.md
│  │  ├─ global.yaml
│  │  └─ agents\
│  │     ├─ memory-officer.md
│  │     ├─ memory-officer.yaml
│  │     ├─ logic-officer.md
│  │     ├─ logic-officer.yaml
│  │     ├─ task-officer.md
│  │     ├─ task-officer.yaml
│  │     ├─ integration-officer.md
│  │     ├─ integration-officer.yaml
│  │     ├─ audit-officer.md
│  │     └─ audit-officer.yaml
│  │
│  ├─ memory\
│  │  ├─ shallow\
│  │  │  ├─ programming.md
│  │  │  ├─ design.md
│  │  │  ├─ art.md
│  │  │  ├─ general.md
│  │  │  ├─ pm.md
│  │  │  └─ project.md
│  │  ├─ deep\
│  │  │  ├─ storage-interface.md
│  │  │  ├─ storage-routes.yaml
│  │  │  ├─ partitions\
│  │  │  │  ├─ programming\
│  │  │  │  ├─ design\
│  │  │  │  ├─ art\
│  │  │  │  ├─ general\
│  │  │  │  ├─ pm\
│  │  │  │  └─ project\
│  │  │  └─ indexes\
│  │  │     ├─ programming-index.md
│  │  │     ├─ design-index.md
│  │  │     ├─ art-index.md
│  │  │     ├─ general-index.md
│  │  │     ├─ pm-index.md
│  │  │     └─ project-index.md
│  │  └─ policies\
│  │     ├─ write-policy.md
│  │     └─ recall-policy.md
│  │
│  ├─ logic\
│  │  ├─ assertions\
│  │  │  ├─ programming.md
│  │  │  ├─ design.md
│  │  │  ├─ art.md
│  │  │  ├─ general.md
│  │  │  ├─ pm.md
│  │  │  ├─ project.md
│  │  │  └─ identity.md
│  │  ├─ rules\
│  │  │  ├─ intent-routing.md
│  │  │  ├─ memory-routing.md
│  │  │  └─ task-routing.md
│  │  └─ executable\
│  │     ├─ programming-rules.yaml
│  │     ├─ design-rules.yaml
│  │     ├─ art-rules.yaml
│  │     ├─ general-rules.yaml
│  │     ├─ pm-rules.yaml
│  │     ├─ project-rules.yaml
│  │     ├─ identity-rules.yaml
│  │     └─ routing-rules.yaml
│  │
│  ├─ skills\
│  │  ├─ registry.yaml
│  │  ├─ wecom\
│  │  │  ├─ skill.md
│  │  │  └─ config.yaml
│  │  ├─ jira\
│  │  │  ├─ skill.md
│  │  │  └─ config.yaml
│  │  └─ knowledge-base\
│  │     ├─ skill.md
│  │     └─ config.yaml
│  │
│  ├─ runtime\
│  │  ├─ orchestration.md
│  │  ├─ message-flow.md
│  │  └─ audit-log-policy.md
│  │
│  └─ docs\
│     ├─ architecture.md
│     ├─ memory-design.md
│     ├─ logic-design.md
│     ├─ skill-plugin-design.md
│     └─ operation-guide.md
│
└─ docs\
   └─ superpowers\
      └─ specs\
         └─ 2026-05-19-baize-intelligent-hub-design.md
```

## 5. 基础设定分区

基础设定分区位于 `G:\Robot\baize\config\`。

`global.md` 用于人类阅读，记录白泽身份、默认语言、项目背景、权限边界和总体行为原则。

`global.yaml` 用于程序读取，记录可执行配置，例如：

```yaml
system:
  name: "白泽"
  nickname: "小泽"
  default_language: "zh-CN"
  role: "project_intelligent_hub"
  expose_internal_agents: false

project:
  genre_reference: "类似荒野乱斗的项目"

storage:
  root: "G:/Robot/baize"
  shallow_memory_path: "G:/Robot/baize/memory/shallow"
  deep_memory_path: "G:/Robot/baize/memory/deep/partitions"
  logic_path: "G:/Robot/baize/logic"
  skills_path: "G:/Robot/baize/skills"

policy:
  require_confirmation_for_sensitive_actions: true
  default_reply_style: "concise_chinese"
```

## 6. 内部子智能体设计

白泽内部包含五个子智能体。它们不直接暴露给使用者，只由白泽主控层调度。

### 6.1 记忆官

职责：

- 管理浅层记忆、深层记忆、索引和归档。
- 判断信息应进入浅层记忆还是深层记忆。
- 维护程序、策划、美术、通用、PM、项目六类记忆。
- 在日常对话中自动归纳可复用信息。
- 根据用户问题召回相关记忆。

### 6.2 逻辑官

职责：

- 管理身份断言、项目断言和行为规则。
- 维护程序、策划、美术、通用、PM、项目、身份七类逻辑断言。
- 把自然语言逻辑同步为可执行 YAML/JSON 规则。
- 被动发现潜在长期逻辑时，必须询问用户是否吸收。

### 6.3 任务官

职责：

- 处理 Jira 任务、待办、统计、日报、周报和进度追踪。
- 将用户口头事项转为待办或 Jira 操作建议。
- 默认先只读 Jira，写入或修改 Jira 前交由审计官判断是否需要确认。

### 6.4 集成官

职责：

- 管理企业微信、Jira、知识库等插件接入。
- 维护插件注册表和插件状态。
- 将外部消息标准化后交给白泽主控层。

### 6.5 审计官

职责：

- 判断敏感操作。
- 在创建、修改、删除外部系统内容前要求确认。
- 记录关键事件、插件调用和配置变更。
- 防止凭据写入 Markdown 文档。

## 7. 记忆系统设计

### 7.1 记忆分类

记忆分为六类：

- 程序记忆：技术方案、代码约定、接口说明、工程实践。
- 策划记忆：玩法、数值、关卡、角色、系统设计。
- 美术记忆：风格、资产规范、角色视觉、UI、特效。
- 通用记忆：跨领域事实、常用偏好、无法明确归类的信息。
- PM 记忆：排期、里程碑、风险、版本计划、会议结论。
- 项目记忆：项目背景、长期目标、核心设定、跨部门共识。

### 7.2 浅层记忆

浅层记忆位于 `G:\Robot\baize\memory\shallow\`，使用 Markdown 存储高频、短小、稳定的信息。

### 7.3 深层记忆

深层记忆采用抽象存储接口，当前本地实现位于 `G:\Robot\baize\memory\deep\partitions\`。

深层记忆适合存储大文档、会议记录、导出文件、知识库 dump、设计素材和长期归档。

深层记忆必须有索引。索引位于 `G:\Robot\baize\memory\deep\indexes\`，记录摘要、标签、路径、更新时间和归属分类。

### 7.4 记忆吸收方式

记忆官支持主动设置和被动吸收。

主动设置：用户明确说“记住”“存到某类记忆”“以后参考这个”等，记忆官直接进入写入流程。用户指定分类时按指定分类写入；用户未指定分类时由记忆官自动判断。

被动吸收：日常对话中出现稳定、可复用的信息时，记忆官可以自动归纳总结后吸收，不需要每次询问用户。对不确定、影响范围大或可能引起误解的信息，记忆官应提示用户确认。

### 7.5 写入判断

```text
短、稳定、高频使用的信息 → 浅层记忆
长、大、低频但重要的信息 → 深层记忆
规则、判断、断言 → 逻辑分区
插件能力、外部系统接入方式 → 技能分区
默认语言、人格、权限边界 → 基础设定分区
```

## 8. 逻辑系统设计

逻辑系统采用双层规则：

- Markdown 解释层：给人看，说明规则含义和适用场景。
- YAML/JSON 执行层：给程序看，用于路由、断言、权限判断。

### 8.1 逻辑分类

逻辑断言分为七类：

- 程序逻辑：技术判断、工程约束、代码流程规则。
- 策划逻辑：玩法判断、数值原则、体验目标。
- 美术逻辑：视觉风格、资产判断、表现规则。
- 通用逻辑：跨领域通用判断。
- PM 逻辑：排期、风险、里程碑、优先级判断。
- 项目逻辑：项目长期目标、核心方向、跨模块判断。
- 身份逻辑：白泽/小泽身份、称呼、默认人格。

### 8.2 逻辑吸收方式

逻辑官支持主动设置和被动发现，但被动发现不能静默写入。

主动设置：用户明确说“把这个作为逻辑规则”“以后只要……就……”等，逻辑官进入逻辑写入流程，写入 Markdown 解释层，并同步生成或更新 YAML/JSON 执行层。

被动发现：当日常对话中出现可能成为长期判断规则的内容时，逻辑官必须询问用户是否吸收。例如：

```text
这句话看起来像一条长期策划逻辑：角色设计优先考虑移动端单手操作。
是否吸收为“策划逻辑断言”？
```

只有用户确认后，逻辑官才能写入逻辑断言。

### 8.3 身份断言示例

`logic/assertions/identity.md`

```md
# 身份断言

- 机器人正式名称：白泽
- 机器人小名：小泽
- 白泽是项目智能中枢，不只是聊天机器人
- 用户对“小泽”的称呼应被识别为对白泽的调用
```

`logic/executable/identity-rules.yaml`

```yaml
identity:
  formal_name: "白泽"
  nickname: "小泽"
  role: "project_intelligent_hub"
  aliases:
    - "小泽"
    - "白泽"
```

## 9. 技能/插件系统设计

企业微信、Jira、项目知识库都作为插件接入，不写死在核心逻辑里。

插件目录位于 `G:\Robot\baize\skills\`。每个插件包含：

- `skill.md`：人类可读说明，定义插件能做什么。
- `config.yaml`：程序可读配置，定义认证方式、入口、权限、速率限制等。

插件注册表示例：

```yaml
plugins:
  - id: wecom
    name: "企业微信插件"
    owner_agent: "integration_officer"
    capabilities:
      - receive_message
      - send_message
    enabled: true

  - id: jira
    name: "Jira Software 插件"
    owner_agent: "task_officer"
    capabilities:
      - query_issues
      - summarize_work
      - create_issue
      - update_issue
    enabled: true

  - id: knowledge_base
    name: "项目知识库插件"
    owner_agent: "memory_officer"
    capabilities:
      - search_documents
      - fetch_document
      - summarize_document
    enabled: true
```

## 10. 企业微信插件设计

企业微信插件负责：

- 接收企业微信机器人 webhook 消息。
- 识别用户对白泽/小泽的调用。
- 将企业微信消息转换为白泽内部统一消息格式。
- 将白泽回复发送回企业微信。

第一版只定义接口和配置结构，不要求立即部署上线。

## 11. Jira Software 插件设计

Jira 插件负责：

- 查询任务。
- 按人员、状态、迭代、标签统计任务。
- 生成日报、周报、风险列表。
- 后续在用户确认后创建或更新任务。

第一版默认只读 Jira。任何写入、修改、删除操作都必须经过审计官判断和用户确认。

## 12. 项目知识库插件设计

项目知识库插件负责：

- 检索项目文档。
- 拉取指定文档内容。
- 总结文档。
- 将重要内容登记到深层记忆索引。

第一版只定义插件能力和配置结构。

## 13. 消息流

以企业微信入口为例：

```text
1. 用户在企业微信里 @白泽 / 小泽
2. 企业微信插件接收 webhook
3. 集成官标准化消息格式
4. 白泽主控层读取全局设定
5. 逻辑官判断用户意图
6. 主控层选择内部子智能体
7. 子智能体根据需要调用记忆、逻辑或插件
8. 审计官判断是否涉及敏感操作
9. 白泽主控层生成统一中文回复
10. 企业微信插件发送回复
11. 审计官记录关键事件
```

## 14. 审计与权限

必须审计的操作：

- 写入、修改、删除 Jira 事项。
- 修改全局设置或子智能体设置。
- 修改逻辑断言和执行规则。
- 写入深层记忆。
- 调用外部系统创建、修改、删除数据。
- 读取或处理疑似敏感文件。

必须确认后执行的操作：

- 删除数据。
- 覆盖已有配置。
- 修改 Jira 状态、负责人、截止日期。
- 批量导入或批量更新。
- 修改插件认证信息。
- 改变白泽身份、默认语言、项目基础设定。

审计日志记录：

```text
时间
用户
入口来源
用户原始请求
识别意图
调用的内部子智能体
调用的插件
是否需要确认
执行结果
错误信息
```

## 15. MVP 边界

第一版必须包含：

- `G:\Robot\baize\` 下的基础目录结构。
- 全局设置文件。
- 五个内部子智能体的独立设置文件。
- 记忆分类、写入策略和召回策略。
- 逻辑分类、吸收策略和执行规则结构。
- 企业微信、Jira、项目知识库三个插件的说明和配置结构。
- 消息流和审计策略文档。

第一版不做：

- 不实现完整 Web 管理后台。
- 不实现真实多模型并发智能体运行。
- 不实现复杂向量数据库。
- 不直接接生产 Jira 写入。
- 不把企业微信机器人直接部署上线。
- 不自动修改 Jira、知识库、配置等外部系统内容。
- 不做跨项目多租户。

## 16. 演进路线

### Phase 0：设计与骨架

完成设计文档，创建目录结构，写入基础配置、分类、策略、插件说明，明确白泽身份和各分区规则。

### Phase 1：本地可用的白泽知识中枢

支持本地读写浅层记忆，登记深层记忆索引，判断记忆分类，维护逻辑断言文件，区分主动设置和被动吸收。

### Phase 2：企业微信接入

企业微信机器人作为消息入口，用户可在企业微信中呼叫白泽/小泽，回复保持统一人格。

### Phase 3：Jira Software 接入

查询 Jira 任务，按人员、状态、迭代、标签统计任务，生成日报、周报、风险列表。先只读，后续经确认后写入。

### Phase 4：项目知识库接入

接入项目文档、策划案、美术资料、技术文档，支持检索、摘要和引用来源，并与深层记忆索引联动。

### Phase 5：智能体编排增强

主控层更稳定地调度记忆官、逻辑官、任务官、集成官、审计官。审计官接管敏感操作确认流程，逐步形成真正的项目智能中枢。

## 17. 后续实现计划入口

实现计划应从 Phase 0 开始，优先创建目录骨架和基础配置文件，再逐步补齐记忆、逻辑、插件和运行机制文档。

推荐下一步：编写实施计划，将 Phase 0 拆分为可执行任务。