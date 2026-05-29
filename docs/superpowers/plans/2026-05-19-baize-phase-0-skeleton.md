# 白泽 Phase 0 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `G:\Robot\baize` 下创建白泽项目智能中枢的 Phase 0 目录骨架、基础配置、子智能体设置、记忆/逻辑/插件/运行机制文档。

**Architecture:** 本阶段不实现服务端代码，只落地可维护的文件系统架构。白泽对外保持单一人格，内部通过记忆官、逻辑官、任务官、集成官、审计官协作；企业微信、Jira、项目知识库作为插件声明接入。

**Tech Stack:** Markdown、YAML、本地文件系统、Bash 验证命令。

---

## Scope

Phase 0 只创建骨架和文档配置，不接入真实企业微信/Jira，不实现运行时服务，不写入生产系统。

## File Structure

### Create directories

- `baize/config/agents/`
- `baize/memory/shallow/`
- `baize/memory/deep/partitions/programming/`
- `baize/memory/deep/partitions/design/`
- `baize/memory/deep/partitions/art/`
- `baize/memory/deep/partitions/general/`
- `baize/memory/deep/partitions/pm/`
- `baize/memory/deep/partitions/project/`
- `baize/memory/deep/indexes/`
- `baize/memory/policies/`
- `baize/logic/assertions/`
- `baize/logic/rules/`
- `baize/logic/executable/`
- `baize/skills/wecom/`
- `baize/skills/jira/`
- `baize/skills/knowledge-base/`
- `baize/runtime/`
- `baize/docs/`

### Create files

- `baize/README.md` — 白泽项目入口说明。
- `baize/config/global.md` — 人类可读全局设定。
- `baize/config/global.yaml` — 程序可读全局配置。
- `baize/config/agents/*.md` — 五个内部子智能体的人类可读职责。
- `baize/config/agents/*.yaml` — 五个内部子智能体的可执行配置。
- `baize/memory/shallow/*.md` — 六类浅层记忆文件。
- `baize/memory/deep/storage-interface.md` — 深层记忆抽象存储接口说明。
- `baize/memory/deep/storage-routes.yaml` — 深层记忆本地路径路由。
- `baize/memory/deep/indexes/*-index.md` — 六类深层记忆索引。
- `baize/memory/policies/write-policy.md` — 记忆写入策略。
- `baize/memory/policies/recall-policy.md` — 记忆召回策略。
- `baize/logic/assertions/*.md` — 七类逻辑断言。
- `baize/logic/rules/*.md` — 意图、记忆、任务路由规则说明。
- `baize/logic/executable/*.yaml` — 可执行逻辑规则。
- `baize/skills/registry.yaml` — 插件注册表。
- `baize/skills/*/skill.md` — 插件能力说明。
- `baize/skills/*/config.yaml` — 插件配置结构。
- `baize/runtime/*.md` — 编排、消息流、审计日志策略。
- `baize/docs/*.md` — 架构、记忆、逻辑、插件、操作文档。

---

### Task 1: Create directory skeleton

**Files:**
- Create directories listed in File Structure.

- [ ] **Step 1: Create all directories**

Run from `G:\Robot`:

```bash
mkdir -p \
  "baize/config/agents" \
  "baize/memory/shallow" \
  "baize/memory/deep/partitions/programming" \
  "baize/memory/deep/partitions/design" \
  "baize/memory/deep/partitions/art" \
  "baize/memory/deep/partitions/general" \
  "baize/memory/deep/partitions/pm" \
  "baize/memory/deep/partitions/project" \
  "baize/memory/deep/indexes" \
  "baize/memory/policies" \
  "baize/logic/assertions" \
  "baize/logic/rules" \
  "baize/logic/executable" \
  "baize/skills/wecom" \
  "baize/skills/jira" \
  "baize/skills/knowledge-base" \
  "baize/runtime" \
  "baize/docs"
```

Expected: command exits with code 0.

- [ ] **Step 2: Verify directories exist**

Run:

```bash
for path in \
  baize/config/agents \
  baize/memory/shallow \
  baize/memory/deep/partitions/programming \
  baize/memory/deep/partitions/design \
  baize/memory/deep/partitions/art \
  baize/memory/deep/partitions/general \
  baize/memory/deep/partitions/pm \
  baize/memory/deep/partitions/project \
  baize/memory/deep/indexes \
  baize/memory/policies \
  baize/logic/assertions \
  baize/logic/rules \
  baize/logic/executable \
  baize/skills/wecom \
  baize/skills/jira \
  baize/skills/knowledge-base \
  baize/runtime \
  baize/docs; do
  test -d "$path" || exit 1
done
```

Expected: command exits with code 0.

---

### Task 2: Create global README and global settings

**Files:**
- Create: `baize/README.md`
- Create: `baize/config/global.md`
- Create: `baize/config/global.yaml`

- [ ] **Step 1: Write `baize/README.md`**

```bash
cat > "baize/README.md" <<'EOF'
# 白泽项目智能中枢

白泽，小名小泽，是当前项目的项目智能中枢。它面向项目知识沉淀、逻辑规则维护、任务统计、外部系统集成和审计管理。

## 核心原则

- 对外只展示统一人格：白泽 / 小泽。
- 内部子智能体不直接暴露给使用者。
- 所有外部系统通过插件接入。
- 当前所有分区存储在 `G:\Robot\baize` 下。
- 默认使用中文回复。
- 当前项目是一个类似荒野乱斗的项目。

## 内部分区

- `config/`：全局设定与子智能体设定。
- `memory/`：浅层记忆、深层记忆、索引与策略。
- `logic/`：逻辑断言、路由规则、可执行规则。
- `skills/`：企业微信、Jira、项目知识库等插件。
- `runtime/`：消息流、编排机制、审计策略。
- `docs/`：维护文档和操作说明。
EOF
```

- [ ] **Step 2: Write `baize/config/global.md`**

```bash
cat > "baize/config/global.md" <<'EOF'
# 白泽全局设定

- 正式名称：白泽。
- 小名：小泽。
- 默认回复语言：中文。
- 项目定位：项目智能中枢。
- 项目背景：当前项目是一个类似荒野乱斗的项目。
- 对外人格：用户只看到统一的白泽 / 小泽。
- 内部子智能体：记忆官、逻辑官、任务官、集成官、审计官。
- 内部子智能体不直接暴露给使用者。
- 企业微信、Jira、项目知识库都作为插件接入。
- 当前所有分区存储在 `G:\Robot\baize` 下。
- 敏感操作必须先确认，再执行。
- 凭据、令牌、密码不得写入 Markdown 文档。
EOF
```

- [ ] **Step 3: Write `baize/config/global.yaml`**

```bash
cat > "baize/config/global.yaml" <<'EOF'
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
  deep_memory_index_path: "G:/Robot/baize/memory/deep/indexes"
  logic_path: "G:/Robot/baize/logic"
  skills_path: "G:/Robot/baize/skills"

policy:
  require_confirmation_for_sensitive_actions: true
  default_reply_style: "concise_chinese"
  credentials_in_markdown: false

internal_agents:
  - memory_officer
  - logic_officer
  - task_officer
  - integration_officer
  - audit_officer
EOF
```

- [ ] **Step 4: Verify global files**

Run:

```bash
test -f "baize/README.md" && \
test -f "baize/config/global.md" && \
test -f "baize/config/global.yaml"
```

Expected: command exits with code 0.

---

### Task 3: Create internal agent settings

**Files:**
- Create: `baize/config/agents/memory-officer.md`
- Create: `baize/config/agents/memory-officer.yaml`
- Create: `baize/config/agents/logic-officer.md`
- Create: `baize/config/agents/logic-officer.yaml`
- Create: `baize/config/agents/task-officer.md`
- Create: `baize/config/agents/task-officer.yaml`
- Create: `baize/config/agents/integration-officer.md`
- Create: `baize/config/agents/integration-officer.yaml`
- Create: `baize/config/agents/audit-officer.md`
- Create: `baize/config/agents/audit-officer.yaml`

- [ ] **Step 1: Write memory officer files**

```bash
cat > "baize/config/agents/memory-officer.md" <<'EOF'
# 记忆官设定

记忆官负责管理白泽的浅层记忆、深层记忆、索引、归档和召回。

## 职责

- 判断信息应写入浅层记忆、深层记忆、逻辑分区、技能分区还是基础设定分区。
- 维护程序、策划、美术、通用、PM、项目六类记忆。
- 用户主动要求记忆时，进入记忆写入流程。
- 日常对话中出现稳定、可复用信息时，可以自动归纳吸收。
- 对不确定、影响范围大或可能误解的信息，先询问用户。
- 召回记忆时先查浅层记忆，再查深层索引，最后按需读取深层原文。
EOF

cat > "baize/config/agents/memory-officer.yaml" <<'EOF'
id: memory_officer
name: "记忆官"
exposed_to_user: false
categories:
  - programming
  - design
  - art
  - general
  - pm
  - project
can_passively_absorb: true
passive_absorption_requires_confirmation: false
confirmation_required_when:
  - high_impact
  - ambiguous_category
  - possible_misunderstanding
storage_paths:
  shallow: "G:/Robot/baize/memory/shallow"
  deep_partitions: "G:/Robot/baize/memory/deep/partitions"
  deep_indexes: "G:/Robot/baize/memory/deep/indexes"
EOF
```

- [ ] **Step 2: Write logic officer files**

```bash
cat > "baize/config/agents/logic-officer.md" <<'EOF'
# 逻辑官设定

逻辑官负责维护白泽的身份断言、项目断言、行为规则和可执行判断规则。

## 职责

- 维护程序、策划、美术、通用、PM、项目、身份七类逻辑断言。
- 将自然语言逻辑写入 Markdown 解释层。
- 将可执行判断写入 YAML 规则层。
- 用户主动要求设置逻辑时，进入逻辑写入流程。
- 日常对话中发现潜在长期逻辑时，必须询问用户是否吸收。
- 未经用户确认，不得静默吸收被动发现的逻辑断言。
EOF

cat > "baize/config/agents/logic-officer.yaml" <<'EOF'
id: logic_officer
name: "逻辑官"
exposed_to_user: false
categories:
  - programming
  - design
  - art
  - general
  - pm
  - project
  - identity
can_passively_absorb: true
passive_absorption_requires_confirmation: true
rule_layers:
  human_readable: "G:/Robot/baize/logic/assertions"
  executable: "G:/Robot/baize/logic/executable"
EOF
```

- [ ] **Step 3: Write task officer files**

```bash
cat > "baize/config/agents/task-officer.md" <<'EOF'
# 任务官设定

任务官负责处理项目任务、Jira 查询、任务统计、日报、周报、风险列表和进度追踪。

## 职责

- 将用户口头事项转为待办或 Jira 操作建议。
- 查询 Jira 任务并生成统计摘要。
- 默认只读 Jira。
- 创建、修改、删除 Jira 内容前，交由审计官判断并要求用户确认。
EOF

cat > "baize/config/agents/task-officer.yaml" <<'EOF'
id: task_officer
name: "任务官"
exposed_to_user: false
plugins:
  - jira
jira_default_mode: read_only
write_actions_require_audit: true
supported_outputs:
  - daily_report
  - weekly_report
  - risk_list
  - workload_summary
EOF
```

- [ ] **Step 4: Write integration officer files**

```bash
cat > "baize/config/agents/integration-officer.md" <<'EOF'
# 集成官设定

集成官负责管理企业微信、Jira、项目知识库等外部系统插件接入。

## 职责

- 维护插件注册表。
- 检查插件启用状态。
- 将外部入口消息转换为白泽内部统一消息格式。
- 将白泽回复交给对应入口插件发送。
EOF

cat > "baize/config/agents/integration-officer.yaml" <<'EOF'
id: integration_officer
name: "集成官"
exposed_to_user: false
plugin_registry: "G:/Robot/baize/skills/registry.yaml"
managed_plugins:
  - wecom
  - jira
  - knowledge_base
message_normalization_required: true
EOF
```

- [ ] **Step 5: Write audit officer files**

```bash
cat > "baize/config/agents/audit-officer.md" <<'EOF'
# 审计官设定

审计官负责权限、安全、敏感操作确认、关键事件记录和凭据保护。

## 职责

- 判断操作是否敏感。
- 在创建、修改、删除外部系统内容前要求用户确认。
- 记录配置变更、深层记忆写入、插件调用和外部系统写入。
- 阻止凭据、令牌、密码写入 Markdown 文档。
EOF

cat > "baize/config/agents/audit-officer.yaml" <<'EOF'
id: audit_officer
name: "审计官"
exposed_to_user: false
sensitive_actions:
  - delete_data
  - overwrite_config
  - modify_jira_issue
  - bulk_import
  - bulk_update
  - modify_plugin_credentials
  - change_global_identity
  - write_deep_memory
confirmation_required: true
forbidden_markdown_content:
  - password
  - token
  - secret
  - credential
EOF
```

- [ ] **Step 6: Verify agent files**

Run:

```bash
for file in \
  baize/config/agents/memory-officer.md \
  baize/config/agents/memory-officer.yaml \
  baize/config/agents/logic-officer.md \
  baize/config/agents/logic-officer.yaml \
  baize/config/agents/task-officer.md \
  baize/config/agents/task-officer.yaml \
  baize/config/agents/integration-officer.md \
  baize/config/agents/integration-officer.yaml \
  baize/config/agents/audit-officer.md \
  baize/config/agents/audit-officer.yaml; do
  test -s "$file" || exit 1
done
```

Expected: command exits with code 0.

---

### Task 4: Create memory system files

**Files:**
- Create: `baize/memory/shallow/programming.md`
- Create: `baize/memory/shallow/design.md`
- Create: `baize/memory/shallow/art.md`
- Create: `baize/memory/shallow/general.md`
- Create: `baize/memory/shallow/pm.md`
- Create: `baize/memory/shallow/project.md`
- Create: `baize/memory/deep/storage-interface.md`
- Create: `baize/memory/deep/storage-routes.yaml`
- Create: `baize/memory/deep/indexes/programming-index.md`
- Create: `baize/memory/deep/indexes/design-index.md`
- Create: `baize/memory/deep/indexes/art-index.md`
- Create: `baize/memory/deep/indexes/general-index.md`
- Create: `baize/memory/deep/indexes/pm-index.md`
- Create: `baize/memory/deep/indexes/project-index.md`
- Create: `baize/memory/policies/write-policy.md`
- Create: `baize/memory/policies/recall-policy.md`

- [ ] **Step 1: Write shallow memory files**

```bash
cat > "baize/memory/shallow/programming.md" <<'EOF'
# 程序记忆

用于记录技术方案、代码约定、接口说明、工程实践和程序相关稳定事实。
EOF

cat > "baize/memory/shallow/design.md" <<'EOF'
# 策划记忆

用于记录玩法、数值、关卡、角色、系统设计和策划相关稳定事实。
EOF

cat > "baize/memory/shallow/art.md" <<'EOF'
# 美术记忆

用于记录风格、资产规范、角色视觉、UI、特效和美术相关稳定事实。
EOF

cat > "baize/memory/shallow/general.md" <<'EOF'
# 通用记忆

用于记录跨领域事实、常用偏好和无法明确归入其他分类的信息。
EOF

cat > "baize/memory/shallow/pm.md" <<'EOF'
# PM 记忆

用于记录排期、里程碑、风险、版本计划、会议结论和项目管理相关稳定事实。
EOF

cat > "baize/memory/shallow/project.md" <<'EOF'
# 项目记忆

用于记录项目背景、长期目标、核心设定和跨部门共识。

## 已知项目事实

- 当前项目是一个类似荒野乱斗的项目。
EOF
```

- [ ] **Step 2: Write deep memory storage files**

```bash
cat > "baize/memory/deep/storage-interface.md" <<'EOF'
# 深层记忆存储接口

深层记忆用于保存大文档、会议记录、导出文件、知识库 dump、设计素材和长期归档。

## 当前实现

当前深层记忆使用本地文件系统实现，根路径为：

`G:\Robot\baize\memory\deep\partitions`

## 接口原则

- 上层只通过分类和索引访问深层记忆。
- 深层记忆原文不默认加载到上下文。
- 每个深层记忆文件必须在对应索引中记录摘要、标签、路径和更新时间。
- 未来可替换为 NAS、对象存储或数据库，替换时不改变记忆官使用方式。
EOF

cat > "baize/memory/deep/storage-routes.yaml" <<'EOF'
storage_backend: local_filesystem
root: "G:/Robot/baize/memory/deep/partitions"
partitions:
  programming: "G:/Robot/baize/memory/deep/partitions/programming"
  design: "G:/Robot/baize/memory/deep/partitions/design"
  art: "G:/Robot/baize/memory/deep/partitions/art"
  general: "G:/Robot/baize/memory/deep/partitions/general"
  pm: "G:/Robot/baize/memory/deep/partitions/pm"
  project: "G:/Robot/baize/memory/deep/partitions/project"
indexes:
  programming: "G:/Robot/baize/memory/deep/indexes/programming-index.md"
  design: "G:/Robot/baize/memory/deep/indexes/design-index.md"
  art: "G:/Robot/baize/memory/deep/indexes/art-index.md"
  general: "G:/Robot/baize/memory/deep/indexes/general-index.md"
  pm: "G:/Robot/baize/memory/deep/indexes/pm-index.md"
  project: "G:/Robot/baize/memory/deep/indexes/project-index.md"
EOF
```

- [ ] **Step 3: Write deep memory indexes**

```bash
cat > "baize/memory/deep/indexes/programming-index.md" <<'EOF'
# 程序深层记忆索引

| 标题 | 路径 | 标签 | 摘要 | 更新时间 |
|---|---|---|---|---|
EOF

cat > "baize/memory/deep/indexes/design-index.md" <<'EOF'
# 策划深层记忆索引

| 标题 | 路径 | 标签 | 摘要 | 更新时间 |
|---|---|---|---|---|
EOF

cat > "baize/memory/deep/indexes/art-index.md" <<'EOF'
# 美术深层记忆索引

| 标题 | 路径 | 标签 | 摘要 | 更新时间 |
|---|---|---|---|---|
EOF

cat > "baize/memory/deep/indexes/general-index.md" <<'EOF'
# 通用深层记忆索引

| 标题 | 路径 | 标签 | 摘要 | 更新时间 |
|---|---|---|---|---|
EOF

cat > "baize/memory/deep/indexes/pm-index.md" <<'EOF'
# PM 深层记忆索引

| 标题 | 路径 | 标签 | 摘要 | 更新时间 |
|---|---|---|---|---|
EOF

cat > "baize/memory/deep/indexes/project-index.md" <<'EOF'
# 项目深层记忆索引

| 标题 | 路径 | 标签 | 摘要 | 更新时间 |
|---|---|---|---|---|
EOF
```

- [ ] **Step 4: Write memory policies**

```bash
cat > "baize/memory/policies/write-policy.md" <<'EOF'
# 记忆写入策略

## 主动设置

当用户明确说“记住”“存到某类记忆”“以后参考这个”时，记忆官进入写入流程。

- 用户指定分类时，写入指定分类。
- 用户未指定分类时，记忆官按内容判断分类。
- 短、稳定、高频信息写入浅层记忆。
- 长、大、低频但重要的信息写入深层记忆并更新索引。

## 被动吸收

日常对话中出现稳定、可复用信息时，记忆官可以自动归纳总结后吸收。

- 不原样保存整段聊天。
- 归纳为短句或摘要。
- 对不确定、影响范围大或可能引起误解的信息，先询问用户。

## 分区判断

- 规则、判断、断言写入逻辑分区。
- 插件能力和外部系统接入方式写入技能分区。
- 默认语言、人格、权限边界写入基础设定分区。
EOF

cat > "baize/memory/policies/recall-policy.md" <<'EOF'
# 记忆召回策略

记忆召回应按成本从低到高执行。

1. 先读取浅层记忆。
2. 如果浅层记忆不足，读取深层记忆索引。
3. 如果索引命中，再按需读取深层记忆原文。
4. 如果记忆之间冲突，优先提示审计官记录冲突并请求用户确认。

召回结果应优先引用分类、文件路径和摘要，避免无来源的长期判断。
EOF
```

- [ ] **Step 5: Verify memory files**

Run:

```bash
for file in \
  baize/memory/shallow/programming.md \
  baize/memory/shallow/design.md \
  baize/memory/shallow/art.md \
  baize/memory/shallow/general.md \
  baize/memory/shallow/pm.md \
  baize/memory/shallow/project.md \
  baize/memory/deep/storage-interface.md \
  baize/memory/deep/storage-routes.yaml \
  baize/memory/deep/indexes/programming-index.md \
  baize/memory/deep/indexes/design-index.md \
  baize/memory/deep/indexes/art-index.md \
  baize/memory/deep/indexes/general-index.md \
  baize/memory/deep/indexes/pm-index.md \
  baize/memory/deep/indexes/project-index.md \
  baize/memory/policies/write-policy.md \
  baize/memory/policies/recall-policy.md; do
  test -s "$file" || exit 1
done
```

Expected: command exits with code 0.

---

### Task 5: Create logic system files

**Files:**
- Create: `baize/logic/assertions/programming.md`
- Create: `baize/logic/assertions/design.md`
- Create: `baize/logic/assertions/art.md`
- Create: `baize/logic/assertions/general.md`
- Create: `baize/logic/assertions/pm.md`
- Create: `baize/logic/assertions/project.md`
- Create: `baize/logic/assertions/identity.md`
- Create: `baize/logic/rules/intent-routing.md`
- Create: `baize/logic/rules/memory-routing.md`
- Create: `baize/logic/rules/task-routing.md`
- Create: `baize/logic/executable/programming-rules.yaml`
- Create: `baize/logic/executable/design-rules.yaml`
- Create: `baize/logic/executable/art-rules.yaml`
- Create: `baize/logic/executable/general-rules.yaml`
- Create: `baize/logic/executable/pm-rules.yaml`
- Create: `baize/logic/executable/project-rules.yaml`
- Create: `baize/logic/executable/identity-rules.yaml`
- Create: `baize/logic/executable/routing-rules.yaml`

- [ ] **Step 1: Write logic assertion Markdown files**

```bash
cat > "baize/logic/assertions/programming.md" <<'EOF'
# 程序逻辑断言

用于记录技术判断、工程约束和代码流程规则。
EOF

cat > "baize/logic/assertions/design.md" <<'EOF'
# 策划逻辑断言

用于记录玩法判断、数值原则和体验目标。
EOF

cat > "baize/logic/assertions/art.md" <<'EOF'
# 美术逻辑断言

用于记录视觉风格、资产判断和表现规则。
EOF

cat > "baize/logic/assertions/general.md" <<'EOF'
# 通用逻辑断言

用于记录跨领域通用判断。
EOF

cat > "baize/logic/assertions/pm.md" <<'EOF'
# PM 逻辑断言

用于记录排期、风险、里程碑和优先级判断。
EOF

cat > "baize/logic/assertions/project.md" <<'EOF'
# 项目逻辑断言

用于记录项目长期目标、核心方向和跨模块判断。

## 已确认断言

- 当前项目是一个类似荒野乱斗的项目。
EOF

cat > "baize/logic/assertions/identity.md" <<'EOF'
# 身份逻辑断言

## 已确认断言

- 机器人正式名称：白泽。
- 机器人小名：小泽。
- 白泽是项目智能中枢，不只是聊天机器人。
- 用户对“小泽”的称呼应被识别为对白泽的调用。
- 白泽对外只展示统一人格，不暴露内部子智能体。
EOF
```

- [ ] **Step 2: Write logic route Markdown files**

```bash
cat > "baize/logic/rules/intent-routing.md" <<'EOF'
# 意图路由规则

- 用户询问历史信息、项目事实、文档沉淀时，优先路由给记忆官。
- 用户要求设置规则、断言、判断标准时，优先路由给逻辑官。
- 用户询问 Jira、待办、统计、日报、周报时，优先路由给任务官。
- 用户提到企业微信、Jira、知识库插件状态或接入时，优先路由给集成官。
- 用户请求删除、覆盖、外部写入、批量修改、凭据变更时，必须路由给审计官。
EOF

cat > "baize/logic/rules/memory-routing.md" <<'EOF'
# 记忆路由规则

- 用户明确说“记住”时，进入记忆官主动设置流程。
- 用户日常对话中出现稳定、可复用信息时，记忆官可以被动归纳吸收。
- 规则、判断、断言不写入记忆分区，应转交逻辑官。
- 长文档、大文件、导出文件写入深层记忆，并更新索引。
- 高频短事实写入浅层记忆。
EOF

cat > "baize/logic/rules/task-routing.md" <<'EOF'
# 任务路由规则

- 查询 Jira 时，任务官调用 Jira 插件只读能力。
- 统计任务时，任务官按人员、状态、迭代、标签聚合结果。
- 创建、修改、删除 Jira 事项前，必须交由审计官确认。
- 用户口头事项不一定直接写入 Jira，可先整理为待办建议。
EOF
```

- [ ] **Step 3: Write executable YAML rules**

```bash
cat > "baize/logic/executable/programming-rules.yaml" <<'EOF'
category: programming
name: "程序逻辑"
assertions: []
EOF

cat > "baize/logic/executable/design-rules.yaml" <<'EOF'
category: design
name: "策划逻辑"
assertions: []
EOF

cat > "baize/logic/executable/art-rules.yaml" <<'EOF'
category: art
name: "美术逻辑"
assertions: []
EOF

cat > "baize/logic/executable/general-rules.yaml" <<'EOF'
category: general
name: "通用逻辑"
assertions: []
EOF

cat > "baize/logic/executable/pm-rules.yaml" <<'EOF'
category: pm
name: "PM 逻辑"
assertions: []
EOF

cat > "baize/logic/executable/project-rules.yaml" <<'EOF'
category: project
name: "项目逻辑"
assertions:
  - id: project.genre.reference
    statement: "当前项目是一个类似荒野乱斗的项目。"
    status: confirmed
EOF

cat > "baize/logic/executable/identity-rules.yaml" <<'EOF'
identity:
  formal_name: "白泽"
  nickname: "小泽"
  role: "project_intelligent_hub"
  expose_internal_agents: false
  aliases:
    - "白泽"
    - "小泽"
EOF

cat > "baize/logic/executable/routing-rules.yaml" <<'EOF'
routing:
  memory_keywords:
    - "记住"
    - "存到记忆"
    - "以后参考"
  logic_keywords:
    - "作为逻辑"
    - "作为规则"
    - "以后只要"
  task_keywords:
    - "Jira"
    - "任务"
    - "日报"
    - "周报"
    - "统计"
  audit_keywords:
    - "删除"
    - "覆盖"
    - "批量"
    - "修改凭据"
passive_absorption:
  memory_requires_confirmation: false
  logic_requires_confirmation: true
EOF
```

- [ ] **Step 4: Verify logic files**

Run:

```bash
for file in \
  baize/logic/assertions/programming.md \
  baize/logic/assertions/design.md \
  baize/logic/assertions/art.md \
  baize/logic/assertions/general.md \
  baize/logic/assertions/pm.md \
  baize/logic/assertions/project.md \
  baize/logic/assertions/identity.md \
  baize/logic/rules/intent-routing.md \
  baize/logic/rules/memory-routing.md \
  baize/logic/rules/task-routing.md \
  baize/logic/executable/programming-rules.yaml \
  baize/logic/executable/design-rules.yaml \
  baize/logic/executable/art-rules.yaml \
  baize/logic/executable/general-rules.yaml \
  baize/logic/executable/pm-rules.yaml \
  baize/logic/executable/project-rules.yaml \
  baize/logic/executable/identity-rules.yaml \
  baize/logic/executable/routing-rules.yaml; do
  test -s "$file" || exit 1
done
```

Expected: command exits with code 0.

---

### Task 6: Create plugin system files

**Files:**
- Create: `baize/skills/registry.yaml`
- Create: `baize/skills/wecom/skill.md`
- Create: `baize/skills/wecom/config.yaml`
- Create: `baize/skills/jira/skill.md`
- Create: `baize/skills/jira/config.yaml`
- Create: `baize/skills/knowledge-base/skill.md`
- Create: `baize/skills/knowledge-base/config.yaml`

- [ ] **Step 1: Write plugin registry**

```bash
cat > "baize/skills/registry.yaml" <<'EOF'
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
    default_mode: read_only

  - id: knowledge_base
    name: "项目知识库插件"
    owner_agent: "memory_officer"
    capabilities:
      - search_documents
      - fetch_document
      - summarize_document
    enabled: true
EOF
```

- [ ] **Step 2: Write enterprise WeChat plugin files**

```bash
cat > "baize/skills/wecom/skill.md" <<'EOF'
# 企业微信插件

企业微信插件负责把企业微信机器人消息接入白泽，并把白泽回复发送回企业微信。

## 能力

- 接收企业微信机器人 webhook 消息。
- 识别用户对白泽 / 小泽的调用。
- 将企业微信消息转换为白泽内部统一消息格式。
- 将白泽回复发送回企业微信。

## Phase 0 边界

本阶段只定义插件能力和配置结构，不部署企业微信机器人。
EOF

cat > "baize/skills/wecom/config.yaml" <<'EOF'
id: wecom
enabled: true
mode: config_schema_only
webhook:
  receive_path: "/plugins/wecom/webhook"
  send_method: "webhook_response"
security:
  credentials_source: "environment"
  write_credentials_to_markdown: false
EOF
```

- [ ] **Step 3: Write Jira plugin files**

```bash
cat > "baize/skills/jira/skill.md" <<'EOF'
# Jira Software 插件

Jira 插件负责查询任务、统计任务、生成日报周报和整理风险列表。

## 能力

- 查询 Jira 任务。
- 按人员、状态、迭代、标签统计任务。
- 生成日报、周报和风险列表。
- 在用户确认后创建或更新任务。

## Phase 0 边界

本阶段只定义插件能力和配置结构。默认只读，不连接生产 Jira。
EOF

cat > "baize/skills/jira/config.yaml" <<'EOF'
id: jira
enabled: true
mode: config_schema_only
default_access: read_only
allowed_operations:
  - query_issues
  - summarize_work
restricted_operations:
  - create_issue
  - update_issue
  - delete_issue
security:
  credentials_source: "environment"
  write_credentials_to_markdown: false
  write_operations_require_confirmation: true
EOF
```

- [ ] **Step 4: Write knowledge base plugin files**

```bash
cat > "baize/skills/knowledge-base/skill.md" <<'EOF'
# 项目知识库插件

项目知识库插件负责检索项目文档、读取指定文档、总结文档，并将重要内容登记到深层记忆索引。

## 能力

- 检索项目文档。
- 拉取指定文档内容。
- 总结文档。
- 登记深层记忆索引。

## Phase 0 边界

本阶段只定义插件能力和配置结构，不接入真实知识库。
EOF

cat > "baize/skills/knowledge-base/config.yaml" <<'EOF'
id: knowledge_base
enabled: true
mode: config_schema_only
allowed_operations:
  - search_documents
  - fetch_document
  - summarize_document
  - register_deep_memory_index
security:
  credentials_source: "environment"
  write_credentials_to_markdown: false
EOF
```

- [ ] **Step 5: Verify plugin files**

Run:

```bash
for file in \
  baize/skills/registry.yaml \
  baize/skills/wecom/skill.md \
  baize/skills/wecom/config.yaml \
  baize/skills/jira/skill.md \
  baize/skills/jira/config.yaml \
  baize/skills/knowledge-base/skill.md \
  baize/skills/knowledge-base/config.yaml; do
  test -s "$file" || exit 1
done
```

Expected: command exits with code 0.

---

### Task 7: Create runtime and docs files

**Files:**
- Create: `baize/runtime/orchestration.md`
- Create: `baize/runtime/message-flow.md`
- Create: `baize/runtime/audit-log-policy.md`
- Create: `baize/docs/architecture.md`
- Create: `baize/docs/memory-design.md`
- Create: `baize/docs/logic-design.md`
- Create: `baize/docs/skill-plugin-design.md`
- Create: `baize/docs/operation-guide.md`

- [ ] **Step 1: Write runtime docs**

```bash
cat > "baize/runtime/orchestration.md" <<'EOF'
# 内部编排机制

白泽主控层负责接收统一消息、读取全局设定、调用逻辑官判断意图，并把任务交给记忆官、逻辑官、任务官、集成官或审计官。

## 编排原则

- 用户只看到白泽 / 小泽。
- 子智能体只在内部协作。
- 涉及外部系统写入时，必须经过审计官。
- 插件由集成官管理，具体业务由对应子智能体发起。
EOF

cat > "baize/runtime/message-flow.md" <<'EOF'
# 消息流

以企业微信入口为例：

1. 用户在企业微信里 @白泽 / 小泽。
2. 企业微信插件接收 webhook。
3. 集成官标准化消息格式。
4. 白泽主控层读取全局设定。
5. 逻辑官判断用户意图。
6. 主控层选择内部子智能体。
7. 子智能体根据需要调用记忆、逻辑或插件。
8. 审计官判断是否涉及敏感操作。
9. 白泽主控层生成统一中文回复。
10. 企业微信插件发送回复。
11. 审计官记录关键事件。
EOF

cat > "baize/runtime/audit-log-policy.md" <<'EOF'
# 审计日志策略

## 必须审计的操作

- 写入、修改、删除 Jira 事项。
- 修改全局设置或子智能体设置。
- 修改逻辑断言和执行规则。
- 写入深层记忆。
- 调用外部系统创建、修改、删除数据。
- 读取或处理疑似敏感文件。

## 审计日志字段

- 时间。
- 用户。
- 入口来源。
- 用户原始请求。
- 识别意图。
- 调用的内部子智能体。
- 调用的插件。
- 是否需要确认。
- 执行结果。
- 错误信息。
EOF
```

- [ ] **Step 2: Write maintenance docs**

```bash
cat > "baize/docs/architecture.md" <<'EOF'
# 白泽架构说明

白泽是项目智能中枢。它对外保持统一人格，内部通过记忆官、逻辑官、任务官、集成官、审计官协作。

外部系统通过插件接入。当前首批插件包括企业微信、Jira Software 和项目知识库。
EOF

cat > "baize/docs/memory-design.md" <<'EOF'
# 记忆系统说明

记忆系统分为浅层记忆和深层记忆。

- 浅层记忆保存高频、短小、稳定的信息。
- 深层记忆保存大文档、会议记录、导出文件、知识库 dump、设计素材和长期归档。
- 深层记忆通过索引召回，不默认读取原文。
- 记忆官可以主动接收用户设置，也可以在日常对话中被动归纳吸收。
EOF

cat > "baize/docs/logic-design.md" <<'EOF'
# 逻辑系统说明

逻辑系统采用双层规则。

- Markdown 解释层用于人类阅读。
- YAML 执行层用于程序判断。
- 逻辑官可以接收用户主动设置的逻辑。
- 逻辑官被动发现潜在长期逻辑时，必须询问用户确认后才能吸收。
EOF

cat > "baize/docs/skill-plugin-design.md" <<'EOF'
# 技能插件系统说明

企业微信、Jira Software、项目知识库都是插件，不写死在白泽核心逻辑里。

每个插件包含：

- `skill.md`：插件能力说明。
- `config.yaml`：插件配置结构。

所有插件统一登记在 `baize/skills/registry.yaml`。
EOF

cat > "baize/docs/operation-guide.md" <<'EOF'
# 操作说明

## 修改全局设定

修改 `baize/config/global.md` 和 `baize/config/global.yaml`。涉及身份、语言、权限边界的修改必须经过确认。

## 添加记忆

短事实写入 `baize/memory/shallow/`。大文件放入 `baize/memory/deep/partitions/` 对应分类，并更新 `baize/memory/deep/indexes/` 中的索引。

## 添加逻辑

人类可读断言写入 `baize/logic/assertions/`。可执行规则写入 `baize/logic/executable/`。

## 添加插件

在 `baize/skills/` 下创建插件目录，并更新 `baize/skills/registry.yaml`。
EOF
```

- [ ] **Step 3: Verify runtime and docs files**

Run:

```bash
for file in \
  baize/runtime/orchestration.md \
  baize/runtime/message-flow.md \
  baize/runtime/audit-log-policy.md \
  baize/docs/architecture.md \
  baize/docs/memory-design.md \
  baize/docs/logic-design.md \
  baize/docs/skill-plugin-design.md \
  baize/docs/operation-guide.md; do
  test -s "$file" || exit 1
done
```

Expected: command exits with code 0.

---

### Task 8: Final verification

**Files:**
- Verify all Phase 0 files.

- [ ] **Step 1: Count created files**

Run:

```bash
python - <<'PY'
from pathlib import Path
root = Path('baize')
files = [p for p in root.rglob('*') if p.is_file()]
print(len(files))
for p in sorted(files):
    print(p.as_posix())
assert len(files) == 62
PY
```

Expected: output lists 62 files under `baize/` and exits with code 0.

- [ ] **Step 2: Verify key design decisions are present**

Run:

```bash
python - <<'PY'
from pathlib import Path
checks = {
    'baize/config/global.md': ['白泽', '小泽', '默认回复语言：中文', '类似荒野乱斗'],
    'baize/config/agents/memory-officer.md': ['主动要求记忆', '自动归纳吸收'],
    'baize/config/agents/logic-officer.md': ['必须询问用户是否吸收', '不得静默吸收'],
    'baize/skills/registry.yaml': ['wecom', 'jira', 'knowledge_base'],
    'baize/runtime/audit-log-policy.md': ['修改全局设置', '写入深层记忆', '错误信息'],
}
for file, needles in checks.items():
    text = Path(file).read_text(encoding='utf-8')
    for needle in needles:
        assert needle in text, f'{needle} missing from {file}'
print('all key checks passed')
PY
```

Expected: prints `all key checks passed` and exits with code 0.

- [ ] **Step 3: Check git availability for commit**

Run:

```bash
git status --short
```

Expected in current environment: `fatal: not a git repository (or any of the parent directories): .git`.

If the repository has been initialized before this step, commit all Phase 0 files with:

```bash
git add baize docs/superpowers/specs/2026-05-19-baize-intelligent-hub-design.md docs/superpowers/plans/2026-05-19-baize-phase-0-skeleton.md
git commit -m "docs: add baize phase 0 skeleton plan"
```

If the directory is not a git repository, do not create a commit.

---

## Self-Review

- Spec coverage: This plan covers Phase 0 directory skeleton, global settings, internal agents, memory system, logic system, plugin declarations, runtime docs, maintenance docs, and verification.
- Placeholder scan: The plan contains no unresolved markers, no incomplete file contents, and no unspecified file paths.
- Scope check: The plan does not implement enterprise WeChat, Jira, knowledge base, web UI, vector database, or real multi-agent runtime. Those remain outside Phase 0.
- Type consistency: Agent IDs, plugin IDs, paths, and category names are consistent across global config, agent config, logic rules, memory routes, and plugin registry.
