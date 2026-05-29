# Plugin Gateway 契约

适用范围：所有外部插件（当前已登记：Jira；后续 WeCom、Confluence、Notion、Slack 等同理）。

## 强约束（不可绕过）

1. **统一入口**：所有插件的写动作必须经过 `src/services/plugin-gateway-service.js` 提供的 `auditPluginOperation({ plugin, kind, issueKeys?, fields?, triggerSource, baizeRoot })`。不允许任何本地正则/关键词直接调用插件写接口。
2. **意图来源**：写动作的意图必须由 Claude Code 操作意图产生（`runClaudeCodeTask` 的 `operation_intent` 模式），服务端只对 Claude Code 返回的合法 JSON 形态进行执行。
3. **审计判定**：审计官（plugin-gateway 内部按 `plugin` 路由到 `audit-rules/<plugin>.js`）输出 `decision: 'allow' | 'require_confirmation' | 'deny'`，每个 issueKey/字段单独评估，并在 `perIssue` 数组里给出原因。
4. **客户端确认**：`triggerSource: 'client'` 默认 `require_confirmation`，必须通过 `jira_audit_required` 事件持久化到 `baize/runtime/audit-pending/<id>.json`，等客户端 `POST /audit/:id/confirm` 后再执行。
5. **定时任务豁免**：`triggerSource: 'scheduled'` 由审计规则按 plugin 决定能否免确认；当前 Jira 规则：AI 创建单任意写动作免确认，非 AI 单只允许评论增删免确认。
6. **读动作**：`*_search`、`*_list_*` 默认 `allow`，但**仍需经过网关**，便于事件流追踪。
7. **失败回灌**：插件执行失败必须把脱敏错误回灌 Claude Code 分析（`permissionMode: '<plugin>_write_error_analysis'`），只接受白名单恢复动作（`retry_with_unchanged_payload` / `ask_user_for_input` / `not_recoverable`），重试有上限。
8. **新增插件/动作**：必须先在 `src/services/audit-rules/<plugin>.js` 登记规则、在 Claude Code 操作意图 prompt + 解析器登记 kind、在 chat-service 注册执行器 + 网关调用。**没有在审计规则里登记的 plugin，默认 deny**。

## Jira 当前规则

| 场景 | 评论增删（add/delete/list comment） | 其它写（create / update / transition / delete issue） | 读（search） |
|---|---|---|---|
| AI 创建单（`jira-operations/index.json` 里 `status='created'` 的 issueKey）+ client 触发 | require_confirmation | require_confirmation | allow |
| AI 创建单 + scheduled | allow | allow | allow |
| 非 AI 单 + client 触发 | require_confirmation | **deny** | allow |
| 非 AI 单 + scheduled | allow | **deny** | allow |

“AI 创建单”的唯一权威来源是 `baize/runtime/jira-operations/index.json`，通过 `src/services/jira-origin-service.js` 暴露。

### jira_bulk_create 特例

由于 `jira_bulk_create` 是“无中生有创建新单子”，没有 issueKey 可审计。网关规则按触发源决定：
- client 触发 → `require_confirmation`
- scheduled → `allow`

服务端目前继续使用历史的 `jira_operation_required` 确认卡（`createJiraCreateOperation` + `confirmJiraOperationThroughClaudeCode`）作为该意图的客户端确认 UI；语义上等价于网关产生的 `jira_audit_required`。未来若统一 UI，应将其改为发 `jira_audit_required` 事件。

## 设计意图

- 把“风险评估”集中到一个网关，避免聊天链路 / 路由 / 客户端各自重复判定，规则永远只有一处可信。
- 把“客户端确认”这一动作显式建模为一种插件级事件 `*_audit_required`，所有插件复用同一种 UI 渲染，未来 WeCom 等增量插件不需要重写客户端卡片逻辑。
- 把“执行失败”的诊断也走 Claude Code，避免每个插件单独写脱敏 + 重试逻辑。

## 守卫

- 任何新增的 `addJiraComment(`、`deleteJiraComment(`、`createJiraIssue(`、`updateJiraIssue(` 等插件写接口调用，必须出现在 `chat-service` 通过 `auditPluginOperation` 已放行的分支里，或在 `src/services/audit/execute-<plugin>.js` 这种执行层。
- 任何绕过 `auditPluginOperation` 直接调用插件写接口的修改都会被这条 assertion 视为违规。
