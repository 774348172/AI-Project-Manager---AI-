const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../config/paths');
const { ensureInside } = require('../lib/file-store');
const { getLogicContext } = require('./logic-service');
const { searchShallowMemory } = require('./memory-service');
const { getSkillsContext } = require('./plugin-service');
const { validatePatch } = require('./patch-policy-service');

function formatList(items, formatter) {
  if (!Array.isArray(items) || items.length === 0) {
    return '无';
  }

  return items.map(formatter).join('\n');
}

function readEnvMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => typeof key === 'string' && key.trim() !== '' && typeof item === 'string' && item.trim() !== ''));
}

function readSettingsEnv(settingsPath) {
  if (typeof settingsPath !== 'string' || settingsPath.trim() === '') {
    return {};
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return readEnvMap(settings.env);
  } catch (error) {
    console.error('[claude-code] failed to read settings env:', error.code || '', error.message);
    return {};
  }
}

function buildClaudeCodeEnv(claudeCodeConfig = {}) {
  return {
    ...process.env,
    ...readSettingsEnv(claudeCodeConfig.settingsPath),
    ...readEnvMap(claudeCodeConfig.env)
  };
}

function normalizeCliPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
}

function getClaudeCodeOwnFolder(claudeCodeConfig = {}) {
  if (typeof claudeCodeConfig.claudeHomePath === 'string' && claudeCodeConfig.claudeHomePath.trim() !== '') {
    return claudeCodeConfig.claudeHomePath.trim();
  }
  if (typeof claudeCodeConfig.settingsPath === 'string' && claudeCodeConfig.settingsPath.trim() !== '') {
    return path.dirname(claudeCodeConfig.settingsPath.trim());
  }
  return null;
}

function buildPermissionInstructions(permissionMode, claudeCodeConfig = {}) {
  if (permissionMode !== 'bug_analysis_workspace') {
    return [
      '你是白泽服务器内部的 Claude Code 工程助手，当前模式为只读或意图解析。',
      '你只能阅读和分析当前项目，不能修改文件，不能读取密钥。',
      '你可以使用 Bash 运行只读分析命令，包括 Python/Node 脚本读取和解析附件；不要执行写文件、删除、安装依赖、网络请求或破坏性命令。'
    ];
  }

  const allowedRoots = [
    claudeCodeConfig.bugAnalysisWorkspacePath,
    getClaudeCodeOwnFolder(claudeCodeConfig)
  ].filter(Boolean);
  return [
    '你是白泽服务器内部的 Claude Code BUG 工程分析助手，当前模式允许 SVN 工作副本维护和工程级分析。',
    '服务器会在启动 BUG 子任务前执行受控 SVN cleanup 和 10 分钟超时的 svn update --accept theirs-full；你只能读取授权目录内的工程文件并执行只读查询命令。',
    '禁止自行执行 svn cleanup、svn update、svn revert 或其他会修改工作副本状态的 SVN 命令；如需确认状态，只允许执行 svn status、svn info 等只读 SVN 查询。',
    '禁止创建、修改、删除文件。',
    `授权目录：${allowedRoots.length > 0 ? allowedRoots.join('；') : '未配置'}`,
    'Jira 写入仍必须由白泽服务器和审计流程执行，你不能直接调用 Jira 写接口或请求凭据。',
    '禁止读取密钥、令牌、密码、Cookie、Authorization、.env、credential、secret、token、apikey 等敏感文件。'
  ];
}

function buildToolPolicy(permissionMode, claudeCodeConfig = {}) {
  const allowed = [
    'Read',
    'Grep',
    'Glob',
    'Bash(python *)',
    'Bash(python - *)',
    'Bash(python3 *)',
    'Bash(python3 - *)',
    'Bash(py *)',
    'Bash(py - *)',
    'Bash(node *)',
    'Bash(node - *)'
  ];

  if (permissionMode === 'bug_analysis_workspace') {
    allowed.push('Bash(svn status *)', 'Bash(svn info *)');
    return {
      tools: 'Read,Grep,Glob,Bash',
      allowedTools: allowed.join(','),
      disallowedTools: 'Edit,Write,NotebookEdit,Bash(svn update *),Bash(svn cleanup *),Bash(svn revert *)'
    };
  }

  return {
    tools: 'Read,Grep,Glob,Bash',
    allowedTools: allowed.join(','),
    disallowedTools: 'Edit,Write,NotebookEdit'
  };
}

function formatLogicContext(logicContext = {}) {
  return [
    '已确认逻辑断言：',
    formatList(logicContext.assertions, (item) => `${item.category || 'assertion'}：${item.content || ''}`),
    '',
    '自然语言规则：',
    formatList(logicContext.rules, (item) => `${item.name || 'rule'}：${item.content || ''}`),
    '',
    '可执行规则配置：',
    formatList(logicContext.executableRules, (item) => `${item.name || 'executable'}：${item.content || ''}`)
  ].join('\n');
}

async function collectClaudeCodeContext(input = {}) {
  const baizeRoot = input.baizeRoot || paths.BAIZE_ROOT;
  const messageText = input.memoryQuery || (input.message && input.message.text) || '';
  const [logicContext, skillsContext, matchedMemory, fallbackMemory] = await Promise.all([
    input.logicContext ? Promise.resolve(input.logicContext) : getLogicContext({ baizeRoot }),
    input.skillsContext ? Promise.resolve(input.skillsContext) : getSkillsContext({ baizeRoot }),
    input.shallowMemoryResults ? Promise.resolve(input.shallowMemoryResults) : searchShallowMemory({ q: messageText, baizeRoot }),
    input.shallowMemoryResults ? Promise.resolve([]) : searchShallowMemory({ baizeRoot })
  ]);
  const shallowMemoryResults = input.shallowMemoryResults || (matchedMemory.length > 0 ? matchedMemory : fallbackMemory).slice(0, 20);
  return { ...input, baizeRoot, logicContext, skillsContext, shallowMemoryResults };
}

function formatAttachmentContext(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return '无';
  }

  return attachments.slice(0, 10).map((attachment, index) => {
    const semanticExtraction = attachment.semanticExtraction && typeof attachment.semanticExtraction.text === 'string'
      ? [
          '服务器高保真表格抽取：',
          `抽取器版本：${attachment.semanticExtraction.extractorVersion || 'unknown'}`,
          `是否截断：${attachment.semanticExtraction.truncated === true ? '是' : '否'}`,
          `sheet：${attachment.semanticExtraction.includedSheetCount || 0}/${attachment.semanticExtraction.sheetCount || 0}`,
          '说明：这是服务器从 xlsx 抽取的结构化镜像，供语义分析使用；不要把它当作最终 Jira 草稿。你仍需根据用户意图判断字段含义、过滤无关列和空行。原始 xlsx 仍可通过“可读取路径”读取；如果抽取内容疑似截断或有歧义，可回退读取原始文件。',
          attachment.semanticExtraction.text.slice(0, 120000)
        ].join('\n')
      : '';
    return [
      `${index + 1}. ${attachment.fileName || attachment.name || attachment.id || 'unnamed'}`,
      attachment.id ? `附件 ID：${attachment.id}` : '',
      attachment.mimeType ? `MIME：${attachment.mimeType}` : '',
      attachment.type ? `类型：${attachment.type}` : '',
      Number.isFinite(attachment.size) ? `大小：${attachment.size} bytes` : '',
      attachment.storagePath ? `存储路径：${attachment.storagePath}` : '',
      attachment.readPath ? `可读取路径：${attachment.readPath}` : '',
      attachment.summary ? `上传分析摘要：${attachment.summary}` : '',
      semanticExtraction
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function formatPendingJiraOperationContext(operation) {
  if (!operation || typeof operation !== 'object') {
    return '无';
  }
  const drafts = operation.draftImport && Array.isArray(operation.draftImport.drafts)
    ? operation.draftImport.drafts.slice(0, 20).map((draft, index) => ({
        index,
        summary: draft && draft.summary,
        projectKey: draft && draft.projectKey,
        issueType: draft && draft.issueType,
        assignee: draft && draft.assignee,
        priority: draft && draft.priority,
        labels: draft && draft.labels
      }))
    : [];
  return JSON.stringify({
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    conversationId: operation.conversationId,
    clientId: operation.clientId,
    draftCount: operation.draftImport && operation.draftImport.count,
    drafts
  }, null, 2);
}

function buildClaudeCodePrompt({
  message,
  conversationMessages = [],
  conversationSummary,
  knowledgeResults = [],
  shallowMemoryResults = [],
  logicContext = {},
  skillsContext = {},
  attachments = [],
  pendingJiraOperation = null,
  permissionMode = 'read_only',
  claudeCodeConfig = {}
}) {
  const recentMessages = conversationMessages.slice(-20);
  return [
    ...buildPermissionInstructions(permissionMode, claudeCodeConfig),
    '每次处理服务器请求时，必须先阅读逻辑官上下文，并自行判断是否需要调用记忆配合分析问题。',
    '请用中文回答，并把结论整理成用户能直接理解的白泽回复。',
    '如果请求需要读取附件，请优先使用 Read；遇到 xlsx 等二进制表格时，可以用 Bash 调用 Python/Node 在内存中解析原始文件。',
    '调用 Python/Node 解析附件时必须使用 node -e 或 python -c 这类单行只读命令，不要使用 heredoc、多行重定向或临时脚本文件。',
    '',
    `用户问题：${message && message.text ? message.text : ''}`,
    '',
    `会话摘要：${conversationSummary || '无'}`,
    '',
    '最近会话：',
    formatList(recentMessages, (item) => `${item.role || 'unknown'}：${item.text || ''}`),
    '',
    '附件上下文：',
    formatAttachmentContext(attachments),
    '',
    '当前待确认 Jira 操作：',
    formatPendingJiraOperationContext(pendingJiraOperation),
    '',
    '知识库检索：',
    formatList(knowledgeResults, (item, index) => `${index + 1}. ${item.title || '未命名'}：${item.snippet || ''}`),
    '',
    '浅层记忆：',
    formatList(shallowMemoryResults, (item) => `${item.category || 'memory'}：${item.line || ''}`),
    '',
    '逻辑官上下文：',
    formatLogicContext(logicContext),
    '',
    '技能上下文：',
    formatList(skillsContext.skills, (item) => `${item.id || 'skill'}：${item.skillMarkdown || ''}`)
  ].join('\n');
}

function buildClaudeCodeWriteProposalPrompt(input) {
  return [
    buildClaudeCodePrompt(input),
    '',
    '现在请为用户请求生成补丁草案。',
    '安全要求：只能输出 unified diff 补丁草案，不能实际修改文件，不能运行命令，不能读取或修改密钥文件。',
    '范围要求：只修改完成用户请求所必需的文件；不要做无关重构；不要改 node_modules、dist、build、.git、.env 或任何 secret/token/credential/API key 文件。',
    '输出格式必须是 JSON，不要输出 Markdown 代码块：',
    '{"summary":"中文摘要","patch":"unified diff 内容","warnings":["可选中文风险提示"]}'
  ].join('\n');
}

function isJiraCreateOperationIntent(input = {}) {
  return input.route && input.route.intent && input.route.intent.route === 'jira_create';
}

function buildClaudeCodeOperationIntentPrompt(input) {
  const requiresJiraDrafts = isJiraCreateOperationIntent(input);
  const targetIssueKey = input && input.route && input.route.intent && typeof input.route.intent.targetIssueKey === 'string'
    ? input.route.intent.targetIssueKey
    : null;
  const wantsSummarizedComment = Boolean(input && input.route && input.route.intent && input.route.intent.route === 'jira_summarize_then_comment');
  return [
    buildClaudeCodePrompt(input),
    '',
    '现在请判断用户请求属于哪种服务器操作意图，并只输出严格 JSON，不要输出 Markdown 代码块。',
    '你是唯一的业务意图判断方；服务器只做 Claude API 粗分类、安全校验、确认卡、插件执行和凭据保护，不会再用本地正则判断 Jira、工程、附件或逻辑断言意图。',
    '你不能执行 Jira 写入，不能请求或使用 Jira 凭据；Jira 写入必须由服务器创建确认卡并由用户确认后执行。',
    '如果“当前待确认 Jira 操作”不为空，用户可能是在确认、取消或修改这个待确认草稿；请结合用户原文判断并输出对应结构化意图。',
    '如果用户要根据附件创建 Jira 单，优先使用附件上下文里的服务器高保真表格抽取进行语义分析；不要只依据上传分析摘要生成草稿。',
    '如果高保真抽取被截断、有歧义或缺少关键信息，必须读取附件上下文里的原始可读取路径兜底；遇到 xlsx 时用 Bash 调用 Python/Node 解析原始表格。',
    '解析 xlsx 时必须使用 node -e 或 python -c 单行只读命令；不要使用 heredoc、多行重定向或写入临时脚本。',
    '如果用户要创建 Jira 单，请结合上下文生成高质量草稿；drafts 中每一项必须使用英文字段名 summary、description、projectKey、issueType、assignee、priority、labels，不要使用“标题/描述/项目/类型/负责人”等中文字段名。',
    requiresJiraDrafts ? '服务器已经判定当前请求是 Jira 创建；本轮不能返回 engineering_reply，最终必须返回 jira_bulk_create JSON。' : '',
    '如果用户要查询 Jira，请输出查询条件，由服务器 Jira 插件查询。遇到“某人身上的单子/负责人/处理人/任务负责人”等表达时，把用户原文姓名放到 assignee；不要臆造 Jira username，服务器会先调用 Jira 用户搜索把中文姓名解析成真实 username，并同时查询系统 assignee 与配置的任务负责人字段。用户说“BUG单/BUG 单”时优先理解为项目 Key BUG，不要输出 labels=["BUG"]；多个状态要输出 status 数组或用逗号分隔。',
    requiresJiraDrafts ? '' : '如果用户明确要求向某个具体 Jira 单（例如 BUG-123、ABC-9）添加一条评论，并且评论文本是用户自己提供的，请直接输出 jira_add_comment；服务器会在不弹确认卡的情况下直接写入评论。不要把“创建 Jira 单/批量导入”当作评论。',
    requiresJiraDrafts ? '' : '如果用户要求对一个或多个 Jira BUG 单做 AI 分析、工程排查、根因定位、生成分析结论、处理建议，或生成待确认的 Jira 分析评论草稿，请输出 jira_bug_analysis；这表示启动或恢复服务器后台工程级 BUG 分析任务，不是直接写 Jira 评论。issueKeys 必填，保留用户原始顺序并去重，最多 50 个。',
    requiresJiraDrafts ? '' : '如果用户希望你自己总结进展/分析后再把结果发到某个 Jira 单的评论里（例如“帮我总结一下 BUG-123 的进展，写到评论里”），请用 Read/Grep/Glob 与 Bash 单行只读命令收集足够的上下文，再输出 jira_summarize_then_comment；但如果用户明确要求 BUG 工程级分析、排查、根因定位或 AI 分析，应优先输出 jira_bug_analysis。body 必须是你自己写的中文评论，长度不超过 8000 字符，不能复述未经查证的内容；sources 用来标注引用的文件/单号，可选。',
    requiresJiraDrafts ? '' : '如果用户要修改某 Jira 单的字段（标题、描述、优先级、负责人、标签等），请输出 jira_update_issue：issueKey 必填、fields 必填且不能为空对象。除非用户明确要求清空，否则不要写 null。',
    requiresJiraDrafts ? '' : '如果用户要切换某 Jira 单的状态（开始/完成/关闭/转测试），请输出 jira_transition_issue：issueKey 必填、transition.id 或 transition.name 至少给一个；服务器会让 Jira 自己校验合法转换。',
    requiresJiraDrafts ? '' : '如果用户要删除某些 Jira 单本身（而不是删评论），请输出 jira_delete_issue：issueKeys 数组最多 20 个；审计官只会让 AI 创建的 Jira 单允许删除。',
    requiresJiraDrafts ? '' : '如果用户要删 Jira 评论（“删除/清理/清空”等动词 + “评论/备注/comment”），请输出 jira_delete_comment。每个 target 至少包含 issueKey；如果用户指定了某些 commentId，可以用 commentIds 数组带上；filterScope 取值：self_ai_prefix（默认，只删白泽自己写的 AI 前缀评论）、self（白泽自己写的全部评论）、any（任意作者，仅当用户明确写“全部评论/任何评论”时才允许）。服务器会调用审计官按单子作者决定是否需要客户端确认，所以不要试图自己写入。',
    requiresJiraDrafts ? '' : '如果用户给出多个 Jira 单号并要求写入明确的固定评论文本，请输出 jira_bulk_add_comment，entries 数组里每一项是一个单号 + 它自己的评论 body；不要把多个单号合并到同一段评论里写到所有单上，每个 issueKey 必须配它自己的 body；entries 顺序保留用户原始顺序，最多 50 个；服务器会逐个写入，不弹确认卡。不要用 jira_bulk_add_comment 表示 BUG 工程级分析启动。',
    requiresJiraDrafts ? '' : '如果用户明确要新增、补充或更新逻辑官/逻辑断言/规则/记忆官断言，请输出 logic_assertion；category 只能是 programming、design、art、general、pm、project、identity，statement 写成可直接落盘的完整断言。',
    requiresJiraDrafts ? '' : '如果用户要修改当前待确认 Jira 草稿，请输出 jira_update_drafts；operationId 必须等于当前待确认 Jira 操作 id，patch 是应用到草稿的字段补丁。',
    requiresJiraDrafts ? '' : '如果用户用聊天文字确认创建当前待确认 Jira 草稿，请输出 jira_confirm_operation；如果用户取消/放弃当前待确认 Jira 草稿，请输出 jira_reject_operation；operationId 必须等于当前待确认 Jira 操作 id。',
    wantsSummarizedComment ? `服务器已判定本轮属于总结后写评论。${targetIssueKey ? `目标 Jira 单：${targetIssueKey}。` : ''}最终必须返回 jira_summarize_then_comment JSON，并把目标单号原样放在 issueKey。` : '',
    requiresJiraDrafts ? '' : '如果不是 Jira，但适合 Claude Code 只读分析，请输出 engineering_reply。',
    '允许的 JSON 形状：',
    '{"kind":"jira_bulk_create","reply":"中文提示","drafts":[{"summary":"标题","description":"描述","projectKey":"项目Key，可省略","issueType":"类型，可省略","assignee":"负责人，可省略","priority":"优先级，可省略","labels":["标签"]}]}',
    requiresJiraDrafts ? '' : '{"kind":"jira_search","reply":"中文提示","query":{"projectKey":"项目Key，可省略","assignee":"负责人，可省略","status":"状态，可省略","labels":["标签"],"updatedAfter":"YYYY-MM-DD，可省略","updatedBefore":"YYYY-MM-DD，可省略"}}',
    requiresJiraDrafts ? '' : '{"kind":"jira_add_comment","reply":"中文提示","issueKey":"BUG-123","body":"评论内容"}',
    requiresJiraDrafts ? '' : '{"kind":"jira_summarize_then_comment","reply":"中文提示","issueKey":"BUG-123","body":"由你总结的中文评论","sources":[{"type":"file","path":"src/foo.js","label":"可选标签"},{"type":"jira","key":"BUG-99"}]}',
    requiresJiraDrafts ? '' : '{"kind":"jira_bug_analysis","reply":"中文提示","issueKeys":["BUG-1","BUG-2"]}',
    requiresJiraDrafts ? '' : '{"kind":"jira_bulk_add_comment","reply":"中文提示","entries":[{"issueKey":"BUG-1","body":"专属于 BUG-1 的中文评论","sources":[{"type":"file","path":"src/foo.js"}]},{"issueKey":"BUG-2","body":"专属于 BUG-2 的中文评论"}]}',
    requiresJiraDrafts ? '' : '{"kind":"jira_update_issue","reply":"中文提示","issueKey":"BUG-1","fields":{"priority":{"name":"高"},"labels":["new-label"]}}',
    requiresJiraDrafts ? '' : '{"kind":"jira_transition_issue","reply":"中文提示","issueKey":"BUG-1","transition":{"name":"开始处理"}}',
    requiresJiraDrafts ? '' : '{"kind":"jira_delete_issue","reply":"中文提示","issueKeys":["BUG-1","BUG-2"]}',
    requiresJiraDrafts ? '' : '{"kind":"jira_delete_comment","reply":"中文提示","targets":[{"issueKey":"BUG-1"},{"issueKey":"BUG-2","commentIds":["123"]}],"filterScope":"self_ai_prefix"}',
    requiresJiraDrafts ? '' : '{"kind":"logic_assertion","reply":"中文提示","category":"pm","statement":"完整逻辑断言"}',
    requiresJiraDrafts ? '' : '{"kind":"jira_update_drafts","reply":"中文提示","operationId":"jira-op-...","patch":{"projectKey":"JUMP","assignee":"张三","summary":"新标题","description":"新描述","issueType":"需求","priority":"高","labels":["label"]}}',
    requiresJiraDrafts ? '' : '{"kind":"jira_confirm_operation","reply":"中文提示","operationId":"jira-op-..."}',
    requiresJiraDrafts ? '' : '{"kind":"jira_reject_operation","reply":"中文提示","operationId":"jira-op-..."}',
    requiresJiraDrafts ? '' : '{"kind":"engineering_reply","reply":"中文回复"}'
  ].filter((line) => line !== '').join('\n');
}

function buildClaudeCodeConfirmedOperationPrompt(input) {
  const operation = input.operation || {};
  return [
    buildClaudeCodePrompt(input),
    '',
    '用户已经在客户端确认了下面这个服务器待执行操作。',
    '你只能判断服务器是否应该执行这个已确认操作，不能修改 operation，不能创建新的 Jira 草稿，不能接触 Jira 凭据。',
    `已确认操作：${JSON.stringify({ id: operation.id, kind: operation.kind, status: operation.status, draftImport: operation.draftImport }, null, 2)}`,
    '只输出严格 JSON，不要输出 Markdown 代码块：',
    '{"kind":"jira_confirmed_execute","operationId":"上面的 operation id","action":"create"}'
  ].join('\n');
}

function buildClaudeCodeOperationIntentRepairPrompt({ originalOutput, errorMessage }) {
  return [
    '上一次 Claude Code 操作意图输出没有通过服务器解析。',
    `解析错误：${errorMessage || '未知错误'}`,
    '请只根据原始输出修复格式和字段名，不要新增事实，不要执行任何 Jira 写入。',
    '只输出严格 JSON，不要输出 Markdown 代码块，不要解释。',
    '允许的 JSON 形状：',
    '{"kind":"jira_bulk_create","reply":"中文提示","drafts":[{"summary":"标题","description":"描述","projectKey":"项目Key，可省略","issueType":"类型，可省略","assignee":"负责人，可省略","priority":"优先级，可省略","labels":["标签"]}]}',
    '{"kind":"jira_search","reply":"中文提示","query":{"projectKey":"项目Key，可省略","assignee":"负责人，可省略","status":"状态，可省略","labels":["标签"],"updatedAfter":"YYYY-MM-DD，可省略","updatedBefore":"YYYY-MM-DD，可省略"}}',
    '{"kind":"jira_bug_analysis","reply":"中文提示","issueKeys":["BUG-1","BUG-2"]}',
    '{"kind":"jira_add_comment","reply":"中文提示","issueKey":"BUG-123","body":"评论内容"}',
    '{"kind":"jira_summarize_then_comment","reply":"中文提示","issueKey":"BUG-123","body":"由你总结的中文评论","sources":[{"type":"file","path":"src/foo.js"}]}',
    '{"kind":"jira_bulk_add_comment","reply":"中文提示","entries":[{"issueKey":"BUG-1","body":"专属于 BUG-1 的中文评论"}]}',
    '{"kind":"logic_assertion","reply":"中文提示","category":"pm","statement":"完整逻辑断言"}',
    '{"kind":"jira_update_drafts","reply":"中文提示","operationId":"jira-op-...","patch":{"projectKey":"JUMP"}}',
    '{"kind":"jira_confirm_operation","reply":"中文提示","operationId":"jira-op-..."}',
    '{"kind":"jira_reject_operation","reply":"中文提示","operationId":"jira-op-..."}',
    '{"kind":"engineering_reply","reply":"中文回复"}',
    '原始输出：',
    String(originalOutput || '').slice(0, 20000)
  ].join('\n');
}

function buildClaudeCodeJiraCreateIntentRetryPrompt(input, { originalOutput, errorMessage, recovery }) {
  const actionId = recovery && recovery.action ? recovery.action.id : 'retry_with_strict_command_template';
  const actionInstruction = {
    retry_with_node_template: '优先使用 node -e 单行命令读取原始附件路径并解析 xlsx。',
    retry_with_python_template: '优先使用 python -c 单行命令读取原始附件路径并解析 xlsx。',
    retry_with_strict_command_template: '使用允许的 node -e 或 python -c 单行命令读取原始附件路径并解析 xlsx。',
    server_extract_attachment_then_retry: '服务器无法在本轮预提取附件时，仍按原始附件路径重新执行只读解析。'
  }[actionId] || '使用允许的 node -e 或 python -c 单行命令读取原始附件路径并解析 xlsx。';
  return [
    buildClaudeCodeOperationIntentPrompt(input),
    '',
    '上一次输出没有生成 Jira 草稿，因此服务器不会把它展示给用户。',
    `失败原因：${errorMessage || '未知错误'}`,
    recovery && recovery.summary ? `Claude Code 自诊断：${recovery.summary}` : '',
    recovery && recovery.reason ? `诊断原因：${recovery.reason}` : '',
    `恢复动作：${actionId}`,
    `恢复要求：${actionInstruction}`,
    '请重新执行只读分析；不要输出权限失败说明，不要返回 engineering_reply。',
    '最终只输出 jira_bulk_create JSON。',
    '上一次输出：',
    String(originalOutput || '').slice(0, 20000)
  ].filter((line) => line !== '').join('\n');
}

function buildClaudeCodeExecutionErrorAnalysisPrompt(input, { stage, expectedKind, originalOutput, errorMessage }) {
  return [
    buildClaudeCodePrompt(input),
    '',
    '上一次 Claude Code 执行没有完成服务器期望。请只做只读自诊断，不要调用外部系统，不要修改文件，不要创建 Jira 单。',
    '你会收到原始输出、解析错误、允许工具和预期结果。请判断是否存在安全的白名单恢复动作。',
    '如果是误以为 Bash 没权限、没有真正尝试允许的 node -e/python -c、xlsx 读取命令格式不对、或输出格式不对，应该建议安全重试。',
    '不能请求或输出凭据、Token、Cookie；不能建议任意命令或任意补丁。',
    '',
    `失败阶段：${stage || 'operation_intent'}`,
    `预期结果：${expectedKind || 'unknown'}`,
    `解析错误：${errorMessage || '未知错误'}`,
    '允许工具：Read,Grep,Glob,Bash(python *),Bash(python - *),Bash(python3 *),Bash(python3 - *),Bash(py *),Bash(py - *),Bash(node *),Bash(node - *)',
    '原始输出：',
    String(originalOutput || '').slice(0, 20000),
    '',
    '只输出严格 JSON，不要输出 Markdown 代码块。',
    '允许的 JSON 形状：',
    '{"kind":"claude_code_execution_recovery","stage":"operation_intent","expectedKind":"jira_bulk_create","status":"retry_available","summary":"中文说明","reason":"中文原因","action":{"id":"retry_with_strict_command_template","label":"重新按单行命令解析附件","requiresConfirmation":false}}',
    '{"kind":"claude_code_execution_recovery","stage":"operation_intent","expectedKind":"jira_bulk_create","status":"retry_available","summary":"中文说明","reason":"中文原因","action":{"id":"retry_with_node_template","label":"使用 Node 单行命令重试","requiresConfirmation":false}}',
    '{"kind":"claude_code_execution_recovery","stage":"operation_intent","expectedKind":"jira_bulk_create","status":"retry_available","summary":"中文说明","reason":"中文原因","action":{"id":"retry_with_python_template","label":"使用 Python 单行命令重试","requiresConfirmation":false}}',
    '{"kind":"claude_code_execution_recovery","stage":"operation_intent","expectedKind":"jira_bulk_create","status":"needs_user_input","summary":"需要用户补充信息","reason":"中文原因","action":{"id":"ask_user_for_missing_input","label":"请求用户补充","requiresConfirmation":false}}',
    '{"kind":"claude_code_execution_recovery","stage":"operation_intent","expectedKind":"jira_bulk_create","status":"not_recoverable","summary":"中文说明","reason":"中文原因","action":{"id":"not_recoverable","label":"无法自动恢复","requiresConfirmation":false}}'
  ].join('\n');
}

function buildClaudeCodeJiraWriteErrorAnalysisPrompt(input) {
  const failure = input.writeFailure || {};
  return [
    buildClaudeCodePrompt(input),
    '',
    'Jira 写入失败了。请只做只读分析，不要调用 Jira API，不要修改文件。',
    '你会收到意图 kind、脱敏意图载荷、脱敏 Jira 错误、已重试次数。请判断有没有安全恢复动作。',
    '安全规则：不能请求或输出凭据、Token、Cookie、Authorization、Jira 配置或 stack；不能扩大原始意图的影响范围；只能建议白名单动作。',
    '允许动作只有三种：',
    '- retry_with_unchanged_payload：原意图正确，重试一次即可，服务器最多再重试 1 次',
    '- ask_user_for_input：意图含义不完整或字段不被 Jira 接受，需要让用户补充',
    '- not_recoverable：不应自动恢复，请用户/工程师介入',
    '',
    `写入失败上下文：${JSON.stringify({
      kind: failure.kind,
      intent: failure.intent,
      error: failure.error,
      attempt: failure.attempt,
      maxAttempts: failure.maxAttempts
    }, null, 2)}`,
    '',
    '只输出严格 JSON，不要输出 Markdown 代码块。',
    '允许的 JSON 形状：',
    '{"kind":"jira_write_recovery","plugin":"jira","status":"retry_available","summary":"中文说明","reason":"中文原因","action":{"id":"retry_with_unchanged_payload","label":"按原意图重试","requiresConfirmation":false}}',
    '{"kind":"jira_write_recovery","plugin":"jira","status":"needs_user_input","summary":"需要用户补充","reason":"中文原因","action":{"id":"ask_user_for_input","label":"请求用户补充","requiresConfirmation":false},"supplement":{"prompt":"请补充","inputs":[{"id":"value","type":"text","label":"请补充字段","required":true}]}}',
    '{"kind":"jira_write_recovery","plugin":"jira","status":"not_recoverable","summary":"无法自动恢复","reason":"中文原因","action":{"id":"not_recoverable","label":"无法自动恢复","requiresConfirmation":false}}'
  ].join('\n');
}

function buildClaudeCodeJiraSearchErrorAnalysisPrompt(input) {
  const failure = input.searchFailure || {};
  return [
    buildClaudeCodePrompt(input),
    '',
    'Jira 搜索失败了。请只做只读分析，不要调用外部系统，不要修改文件，不要执行 Jira 请求。',
    '你会收到已脱敏的查询条件、服务器生成的 JQL、Jira 错误和错误分类。请判断是否存在安全恢复动作。',
    '安全规则：不能请求或输出凭据、Token、Cookie、Authorization、Jira 配置或 stack；不能建议任意插件写入；只能建议白名单动作。',
    '如果可以安全改写 JQL，请返回 retry_available，服务器会验证 JQL 后最多自动重试 3 次。',
    '如果缺少用户业务判断，请返回 needs_user_input，并提供桌面客户端可渲染的补充输入项。',
    '',
    `搜索失败上下文：${JSON.stringify({
      query: failure.query,
      jql: failure.jql,
      error: failure.error,
      classification: failure.classification,
      attempt: failure.attempt,
      maxAttempts: failure.maxAttempts,
      maxResults: failure.maxResults
    }, null, 2)}`,
    '',
    '只输出严格 JSON，不要输出 Markdown 代码块。',
    '允许的 JSON 形状：',
    '{"kind":"jira_search_recovery","plugin":"jira","status":"retry_available","summary":"中文说明","reason":"中文原因","action":{"id":"retry_with_rewritten_jql","label":"使用修正后的 JQL 重试","requiresConfirmation":false},"retry":{"jql":"project = \\"BUG\\" AND status = \\"处理中\\" ORDER BY updated DESC"}}',
    '{"kind":"jira_search_recovery","plugin":"jira","status":"needs_user_input","summary":"需要用户补充查询条件","reason":"中文原因","action":{"id":"ask_user_for_search_input","label":"请求用户补充查询条件","requiresConfirmation":false},"supplement":{"prompt":"请选择正确的状态","inputs":[{"id":"status","type":"select","label":"Jira 状态","required":true,"options":["未开始","处理中"]}],"actions":[{"id":"submit_supplement","label":"提交补充条件","style":"primary"}]}}',
    '{"kind":"jira_search_recovery","plugin":"jira","status":"not_recoverable","summary":"无法安全自动修复这个 Jira 查询","reason":"中文原因","action":{"id":"not_recoverable","label":"无法自动恢复","requiresConfirmation":false}}'
  ].join('\n');
}

function buildClaudeCodePluginOperationErrorPrompt(input) {
  const operation = input.operation || {};
  const failure = input.failure || operation.failure || {};
  return [
    buildClaudeCodePrompt(input),
    '',
    '一个服务器插件写入操作失败了。请只做只读分析，不要调用外部系统，不要修改文件，不要创建 Jira 单。',
    '你会收到已脱敏的错误和操作上下文。请判断是否存在安全的恢复动作。',
    '安全规则：不能自动执行写入；只能建议低风险、可解释、可由用户确认的恢复动作；不能要求或输出凭据、Token、Cookie。',
    '如果缺少用户业务判断，请返回 needs_user_input，并提供桌面客户端可渲染的补充按钮或输入项。',
    '对 Jira labels 字段不在创建界面的错误，可以建议移除 labels 后重试，因为 labels 是附加字段；但必须让用户点击确认。',
    '',
    `失败操作：${JSON.stringify({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      draftImport: operation.draftImport,
      createdIssues: operation.createdIssues,
      error: operation.error,
      failure
    }, null, 2)}`,
    '',
    '只输出严格 JSON，不要输出 Markdown 代码块。',
    '允许的 JSON 形状：',
    '{"kind":"plugin_operation_recovery","plugin":"jira","operationId":"operation id","status":"available","summary":"中文说明","reason":"中文原因","actions":[{"id":"retry_without_labels","kind":"safe_retry","label":"移除标签后重试创建","style":"primary","requiresConfirmation":true,"riskLevel":"low","description":"中文说明"},{"id":"cancel","kind":"cancel","label":"取消创建","style":"secondary","requiresConfirmation":false}]}',
    '{"kind":"plugin_operation_recovery","plugin":"jira","operationId":"operation id","status":"needs_user_input","summary":"需要用户补充信息","supplement":{"prompt":"请选择正确的项目或字段处理方式","inputs":[{"id":"projectKey","type":"text","label":"项目 Key","required":true}],"actions":[{"id":"submit_supplement","label":"提交补充信息","style":"primary"}]},"actions":[{"id":"cancel","kind":"cancel","label":"取消","style":"secondary"}]}',
    '{"kind":"plugin_operation_recovery","plugin":"jira","operationId":"operation id","status":"not_recoverable","summary":"中文说明","actions":[{"id":"cancel","kind":"cancel","label":"取消","style":"secondary"}]}'
  ].join('\n');
}

function buildClaudeCodePluginOperationRecoveryRepairPrompt({ originalOutput, errorMessage, operation }) {
  return [
    '上一次 Claude Code 插件错误恢复分析输出没有通过服务器解析。',
    `解析错误：${errorMessage || '未知错误'}`,
    '请只修复 JSON 格式和字段名，不要新增事实，不要执行任何插件写入。',
    '只输出严格 JSON，不要输出 Markdown 代码块，不要解释。',
    `operationId 必须是：${operation && operation.id ? operation.id : ''}`,
    '允许 actions.id 仅包含 retry_without_labels、cancel、submit_supplement。',
    '原始输出：',
    String(originalOutput || '').slice(0, 20000)
  ].join('\n');
}

function resolveClaudeCodeWorkspace(claudeCodeConfig = {}, permissionMode = 'read_only') {
  if (permissionMode === 'bug_analysis_workspace' && claudeCodeConfig.bugAnalysisWorkspacePath) {
    return ensureInside(claudeCodeConfig.bugAnalysisWorkspacePath, claudeCodeConfig.bugAnalysisWorkspacePath);
  }
  if (!claudeCodeConfig.workspacePath) {
    return ensureInside(paths.PROJECT_ROOT, paths.PROJECT_ROOT);
  }
  return ensureInside(claudeCodeConfig.workspacePath, claudeCodeConfig.workspacePath);
}

function createClaudeCodeCliRunner({ spawnImpl = spawn } = {}) {
  return function runClaudeCodeCli({ prompt, baizeRoot, permissionMode = 'read_only', claudeCodeConfig = {} }) {
    return new Promise((resolve, reject) => {
      const cwd = resolveClaudeCodeWorkspace(claudeCodeConfig, permissionMode);
      if (baizeRoot) {
        ensureInside(baizeRoot, paths.PROJECT_ROOT);
      }

      const command = claudeCodeConfig.command || 'claude';
      const timeoutMs = claudeCodeConfig.timeoutMs || 300000;
      const toolPolicy = buildToolPolicy(permissionMode, claudeCodeConfig);
      const args = [
        '--print',
        prompt,
        '--output-format',
        'text',
        '--permission-mode',
        'dontAsk',
        '--tools',
        toolPolicy.tools,
        '--allowedTools',
        toolPolicy.allowedTools
      ];
      if (permissionMode === 'bug_analysis_workspace') {
        args.push('--model', claudeCodeConfig.bugAnalysisModel || claudeCodeConfig.fastModel || 'claude-opus-4-7');
      }
      if (toolPolicy.disallowedTools) {
        args.push('--disallowedTools', toolPolicy.disallowedTools);
      }
      if (claudeCodeConfig.settingsPath) {
        args.push('--settings', claudeCodeConfig.settingsPath);
      }
      const child = spawnImpl(command, args, {
        cwd,
        env: buildClaudeCodeEnv(claudeCodeConfig),
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        const error = new Error('Claude Code 处理超时，请稍后重试。');
        error.code = 'CLAUDE_CODE_TIMEOUT';
        error.statusCode = 504;
        error.publicMessage = error.message;
        reject(error);
      }, timeoutMs);

      child.stdout && child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr && child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        console.error('[claude-code] spawn error:', error.code || '', error.message);
        const publicError = new Error(error.code === 'ENOENT'
          ? '服务器没有找到 Claude Code 命令，请确认已安装并配置到 PATH。'
          : 'Claude Code 启动失败，请查看服务器日志。');
        publicError.code = error.code === 'ENOENT' ? 'CLAUDE_CODE_NOT_FOUND' : 'CLAUDE_CODE_START_FAILED';
        publicError.statusCode = 502;
        publicError.publicMessage = publicError.message;
        reject(publicError);
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const trimmedStderr = stderr.trim();
          const trimmedStdout = stdout.trim();
          console.error(`[claude-code] exited code=${code}; stderr=${trimmedStderr || '(empty)'}`);
          if (trimmedStdout) {
            console.error(`[claude-code] stdout tail: ${trimmedStdout.slice(-2000)}`);
          }
          const error = new Error('Claude Code 只读分析失败，请查看服务器日志。');
          error.code = 'CLAUDE_CODE_FAILED';
          error.statusCode = 502;
          error.publicMessage = error.message;
          error.details = trimmedStderr;
          reject(error);
          return;
        }

        resolve(stdout.trim());
      });
    });
  };
}

const defaultReadOnlyRunner = createClaudeCodeCliRunner();

function proposalError(message, code = 'CLAUDE_CODE_PROPOSAL_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function extractJsonProposal(text) {
  const stripped = stripJsonFence(text);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch (nestedError) {
      return null;
    }
  }
}

function extractDiff(text) {
  const stripped = stripJsonFence(text);
  const diffIndex = stripped.indexOf('diff --git ');
  if (diffIndex === -1) {
    return '';
  }
  return stripped.slice(diffIndex).replace(/```$/g, '').trim();
}

function parseClaudeCodePatchProposal(output) {
  const jsonProposal = extractJsonProposal(output);
  const summary = jsonProposal && typeof jsonProposal.summary === 'string' && jsonProposal.summary.trim() !== ''
    ? jsonProposal.summary.trim()
    : 'Claude Code 已生成补丁草案。';
  const patch = jsonProposal && typeof jsonProposal.patch === 'string'
    ? jsonProposal.patch.trim()
    : extractDiff(output);
  if (!patch) {
    throw proposalError('Claude Code 没有生成有效补丁。');
  }

  const validated = validatePatch(patch);
  return {
    summary,
    patch: validated.patch,
    files: validated.files,
    warnings: [
      ...(Array.isArray(jsonProposal && jsonProposal.warnings) ? jsonProposal.warnings.filter((item) => typeof item === 'string') : []),
      ...validated.warnings
    ]
  };
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeLabels(value) {
  return Array.isArray(value) ? value.map(normalizeString).filter(Boolean).slice(0, 20) : [];
}

function normalizeJiraIssueKeys(rawValues, { max = 50, emptyMessage, invalidMessage, overLimitMessage } = {}) {
  const seen = new Set();
  const issueKeys = [];
  for (const candidate of rawValues) {
    const key = firstString(candidate);
    if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
      throw proposalError(invalidMessage || 'Claude Code 意图包含非法 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    issueKeys.push(key);
  }
  if (issueKeys.length === 0) {
    throw proposalError(emptyMessage || 'Claude Code 意图缺少 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (issueKeys.length > max) {
    throw proposalError(overLimitMessage || `Claude Code 意图单号超出 ${max} 条上限。`, 'CLAUDE_CODE_INTENT_INVALID');
  }
  return issueKeys;
}

const LOGIC_ASSERTION_CATEGORIES = new Set(['programming', 'design', 'art', 'general', 'pm', 'project', 'identity']);

function normalizeJiraOperationId(value) {
  const operationId = firstString(value);
  if (!operationId || !/^jira-op-[A-Za-z0-9_-]+$/.test(operationId)) {
    throw proposalError('Claude Code 意图缺少合法的 Jira 操作 ID。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  return operationId;
}

function sanitizeDraftPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw proposalError('Claude Code 草稿修改意图缺少 patch。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const sanitized = {};
  for (const key of ['summary', 'description', 'projectKey', 'issueType', 'assignee', 'priority']) {
    const value = normalizeString(patch[key]);
    if (value) {
      sanitized[key] = value;
    }
  }
  const labels = normalizeLabels(patch.labels);
  if (labels.length > 0) {
    sanitized.labels = labels;
  }
  if (Object.keys(sanitized).length === 0) {
    throw proposalError('Claude Code 草稿修改意图没有可更新字段。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  return sanitized;
}

function parseClaudeCodeOperationIntent(output, options = {}) {
  const parsed = extractJsonProposal(output);
  if (!parsed || typeof parsed !== 'object') {
    throw proposalError('Claude Code 没有返回有效操作意图。', 'CLAUDE_CODE_INTENT_INVALID');
  }

  if (parsed.kind === 'jira_bulk_create') {
    const drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [];
    const sanitizedDrafts = drafts.map((draft) => ({
      summary: firstString(draft && draft.summary, draft && draft.title, draft && draft.name, draft && draft['标题'], draft && draft['名称'], draft && draft['单子名称'], draft && draft['需求名称'], draft && draft['任务名称'], draft && draft['开发内容']),
      description: firstString(draft && draft.description, draft && draft.desc, draft && draft['描述'], draft && draft['需求说明'], draft && draft['内容']) || '',
      projectKey: firstString(draft && draft.projectKey, draft && draft.project, draft && draft['项目Key'], draft && draft['项目']),
      issueType: firstString(draft && draft.issueType, draft && draft.type, draft && draft['类型'], draft && draft['任务类型']),
      assignee: firstString(draft && draft.assignee, draft && draft.owner, draft && draft['负责人'], draft && draft['处理人'], draft && draft['经办人']),
      priority: firstString(draft && draft.priority, draft && draft['优先级']),
      labels: normalizeLabels(draft && draft.labels)
    })).filter((draft) => draft.summary);
    if (sanitizedDrafts.length === 0) {
      throw proposalError('Claude Code 没有生成可确认的 Jira 草稿。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_bulk_create',
      reply: normalizeString(parsed.reply),
      drafts: sanitizedDrafts
    };
  }

  if (parsed.kind === 'jira_search') {
    const query = parsed.query && typeof parsed.query === 'object' ? parsed.query : {};
    return {
      kind: 'jira_search',
      reply: normalizeString(parsed.reply),
      query: {
        projectKey: normalizeString(query.projectKey),
        assignee: normalizeString(query.assignee),
        status: Array.isArray(query.status) ? query.status.map(normalizeString).filter(Boolean) : normalizeString(query.status),
        issueType: normalizeString(query.issueType),
        labels: normalizeLabels(query.labels),
        updatedAfter: normalizeString(query.updatedAfter),
        updatedBefore: normalizeString(query.updatedBefore)
      }
    };
  }

  if (parsed.kind === 'jira_bug_analysis') {
    const rawIssueKeys = Array.isArray(parsed.issueKeys)
      ? parsed.issueKeys
      : (parsed.issueKey ? [parsed.issueKey] : (Array.isArray(parsed.entries) ? parsed.entries.map((entry) => entry && (entry.issueKey || entry.key || entry['单号'] || entry['issue'])) : []));
    return {
      kind: 'jira_bug_analysis',
      reply: normalizeString(parsed.reply),
      issueKeys: normalizeJiraIssueKeys(rawIssueKeys, {
        max: 50,
        emptyMessage: 'Claude Code BUG 分析意图缺少 Jira 单号。',
        invalidMessage: 'Claude Code BUG 分析意图包含非法 Jira 单号。',
        overLimitMessage: 'Claude Code BUG 分析意图单号超出 50 条上限。'
      })
    };
  }

  if (parsed.kind === 'jira_add_comment') {
    const issueKey = firstString(parsed.issueKey, parsed.key, parsed['单号'], parsed['issue']);
    const body = firstString(parsed.body, parsed.comment, parsed['评论'], parsed['内容']);
    if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
      throw proposalError('Claude Code 评论意图缺少合法的 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (!body || body.length > 8000) {
      throw proposalError('Claude Code 评论内容缺失或过长。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_add_comment',
      reply: normalizeString(parsed.reply),
      issueKey,
      body
    };
  }

  if (parsed.kind === 'jira_update_issue') {
    const issueKey = firstString(parsed.issueKey, parsed.key, parsed['单号']);
    if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
      throw proposalError('Claude Code 更新单意图缺少合法的 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const fields = parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields) ? parsed.fields : null;
    if (!fields || Object.keys(fields).length === 0) {
      throw proposalError('Claude Code 更新单意图缺少 fields。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_update_issue',
      reply: normalizeString(parsed.reply),
      issueKey,
      fields
    };
  }

  if (parsed.kind === 'jira_transition_issue') {
    const issueKey = firstString(parsed.issueKey, parsed.key, parsed['单号']);
    if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
      throw proposalError('Claude Code 状态变更意图缺少合法的 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const transition = parsed.transition && typeof parsed.transition === 'object' ? parsed.transition : null;
    const transitionId = transition && firstString(transition.id);
    const transitionName = transition && firstString(transition.name);
    if (!transitionId && !transitionName) {
      throw proposalError('Claude Code 状态变更意图缺少 transition.id 或 transition.name。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_transition_issue',
      reply: normalizeString(parsed.reply),
      issueKey,
      transition: transitionId ? { id: transitionId } : { name: transitionName }
    };
  }

  if (parsed.kind === 'jira_delete_issue') {
    const rawKeys = Array.isArray(parsed.issueKeys) ? parsed.issueKeys : (parsed.issueKey ? [parsed.issueKey] : []);
    const seen = new Set();
    const issueKeys = [];
    for (const candidate of rawKeys) {
      const key = firstString(candidate);
      if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
        throw proposalError('Claude Code 删单意图包含非法 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      issueKeys.push(key);
    }
    if (issueKeys.length === 0) {
      throw proposalError('Claude Code 删单意图缺少 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (issueKeys.length > 20) {
      throw proposalError('Claude Code 删单意图单号超出 20 条上限。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_delete_issue',
      reply: normalizeString(parsed.reply),
      issueKeys
    };
  }

  if (parsed.kind === 'jira_delete_comment') {
    const rawTargets = Array.isArray(parsed.targets) && parsed.targets.length > 0
      ? parsed.targets
      : (Array.isArray(parsed.issueKeys) ? parsed.issueKeys.map((key) => ({ issueKey: key })) : (parsed.issueKey ? [{ issueKey: parsed.issueKey, commentIds: parsed.commentIds }] : []));
    if (rawTargets.length === 0) {
      throw proposalError('Claude Code 删评论意图缺少 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (rawTargets.length > 50) {
      throw proposalError('Claude Code 删评论意图单号超出 50 条上限。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const seen = new Set();
    const targets = [];
    for (const entry of rawTargets) {
      if (!entry || typeof entry !== 'object') {
        throw proposalError('Claude Code 删评论 target 格式非法。', 'CLAUDE_CODE_INTENT_INVALID');
      }
      const issueKey = firstString(entry.issueKey, entry.key, entry['单号']);
      if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
        throw proposalError('Claude Code 删评论意图包含非法 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
      }
      if (seen.has(issueKey)) {
        continue;
      }
      const commentIds = Array.isArray(entry.commentIds) ? entry.commentIds.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)).slice(0, 100) : [];
      seen.add(issueKey);
      targets.push({ issueKey, commentIds });
    }
    if (targets.length === 0) {
      throw proposalError('Claude Code 删评论意图缺少有效 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const filterScope = ['self', 'self_ai_prefix', 'any'].includes(normalizeString(parsed.filterScope))
      ? normalizeString(parsed.filterScope)
      : 'self_ai_prefix';
    return {
      kind: 'jira_delete_comment',
      reply: normalizeString(parsed.reply),
      targets,
      filterScope
    };
  }

  if (parsed.kind === 'jira_bulk_add_comment') {
    const rawEntries = Array.isArray(parsed.entries) && parsed.entries.length > 0
      ? parsed.entries
      : (Array.isArray(parsed.issueKeys) ? parsed.issueKeys.map((key) => ({ issueKey: key, body: parsed.body })) : []);
    if (rawEntries.length === 0) {
      throw proposalError('Claude Code 批量评论缺少 entries。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (rawEntries.length > 50) {
      throw proposalError('Claude Code 批量评论 entries 超出 50 条上限。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const seen = new Set();
    const entries = [];
    for (const entry of rawEntries) {
      if (!entry || typeof entry !== 'object') {
        throw proposalError('Claude Code 批量评论 entry 格式非法。', 'CLAUDE_CODE_INTENT_INVALID');
      }
      const issueKey = firstString(entry.issueKey, entry.key, entry['单号'], entry['issue']);
      if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
        throw proposalError('Claude Code 批量评论包含非法 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
      }
      if (seen.has(issueKey)) {
        continue;
      }
      const body = firstString(entry.body, entry.comment, entry['评论'], entry['内容']);
      if (!body || body.length > 8000) {
        throw proposalError(`Claude Code 批量评论 ${issueKey} 的内容缺失或过长。`, 'CLAUDE_CODE_INTENT_INVALID');
      }
      const sources = Array.isArray(entry.sources) ? entry.sources.map((source) => {
        if (!source || typeof source !== 'object') {
          return null;
        }
        const type = ['file', 'jira', 'note', 'url'].includes(source.type) ? source.type : 'note';
        const ref = normalizeString(source.path) || normalizeString(source.url) || normalizeString(source.key) || normalizeString(source.label);
        if (!ref) {
          return null;
        }
        return {
          type,
          ref,
          label: normalizeString(source.label) || ref
        };
      }).filter(Boolean).slice(0, 12) : [];
      seen.add(issueKey);
      entries.push({ issueKey, body, sources });
    }
    if (entries.length === 0) {
      throw proposalError('Claude Code 批量评论缺少 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_bulk_add_comment',
      reply: normalizeString(parsed.reply),
      entries
    };
  }

  if (parsed.kind === 'jira_summarize_then_comment') {
    const issueKey = firstString(parsed.issueKey, parsed.key, parsed['单号'], parsed['issue']);
    const body = firstString(parsed.body, parsed.comment, parsed['评论'], parsed['内容']);
    if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
      throw proposalError('Claude Code 总结评论意图缺少合法的 Jira 单号。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (!body || body.length > 8000) {
      throw proposalError('Claude Code 总结评论内容缺失或过长。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const sources = Array.isArray(parsed.sources) ? parsed.sources.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const type = ['file', 'jira', 'note', 'url'].includes(entry.type) ? entry.type : 'note';
      const ref = normalizeString(entry.path) || normalizeString(entry.url) || normalizeString(entry.key) || normalizeString(entry.label);
      if (!ref) {
        return null;
      }
      return {
        type,
        ref,
        label: normalizeString(entry.label) || ref
      };
    }).filter(Boolean).slice(0, 12) : [];
    return {
      kind: 'jira_summarize_then_comment',
      reply: normalizeString(parsed.reply),
      issueKey,
      body,
      sources
    };
  }

  if (parsed.kind === 'logic_assertion') {
    if (options.requireJiraBulkCreate) {
      throw proposalError('当前请求必须生成 Jira 草稿，不能返回逻辑断言。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    const category = normalizeString(parsed.category) || 'general';
    const statement = normalizeString(parsed.statement || parsed.content || parsed['断言']);
    if (!LOGIC_ASSERTION_CATEGORIES.has(category)) {
      throw proposalError('Claude Code 逻辑断言分类不支持。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    if (!statement) {
      throw proposalError('Claude Code 逻辑断言缺少 statement。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'logic_assertion',
      reply: normalizeString(parsed.reply),
      category,
      statement
    };
  }

  if (parsed.kind === 'jira_update_drafts') {
    if (options.requireJiraBulkCreate) {
      throw proposalError('当前请求必须生成 Jira 草稿，不能返回草稿修改。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'jira_update_drafts',
      reply: normalizeString(parsed.reply),
      operationId: normalizeJiraOperationId(parsed.operationId || parsed.id),
      patch: sanitizeDraftPatch(parsed.patch || parsed.fields || parsed.draftPatch)
    };
  }

  if (parsed.kind === 'jira_confirm_operation' || parsed.kind === 'jira_reject_operation') {
    if (options.requireJiraBulkCreate) {
      throw proposalError('当前请求必须生成 Jira 草稿，不能返回已有操作确认。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: parsed.kind,
      reply: normalizeString(parsed.reply),
      operationId: normalizeJiraOperationId(parsed.operationId || parsed.id)
    };
  }

  if (parsed.kind === 'engineering_reply') {
    if (options.requireJiraBulkCreate) {
      throw proposalError('当前请求必须生成 Jira 草稿，不能返回普通 Claude Code 回复。', 'CLAUDE_CODE_INTENT_INVALID');
    }
    return {
      kind: 'engineering_reply',
      reply: normalizeString(parsed.reply) || '白泽：Claude Code 已完成分析。'
    };
  }

  throw proposalError('Claude Code 返回了不支持的操作意图。', 'CLAUDE_CODE_INTENT_INVALID');
}

function parseClaudeCodeConfirmedOperationIntent(output, operation) {
  const parsed = extractJsonProposal(output);
  if (!parsed || typeof parsed !== 'object') {
    throw proposalError('Claude Code 没有返回有效确认意图。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (parsed.kind !== 'jira_confirmed_execute' || parsed.action !== 'create' || parsed.operationId !== (operation && operation.id)) {
    throw proposalError('Claude Code 确认意图与当前操作不匹配。', 'CLAUDE_CODE_INTENT_MISMATCH');
  }
  return {
    kind: 'jira_confirmed_execute',
    operationId: parsed.operationId,
    action: 'create'
  };
}

function normalizeJiraSearchRecoveryAction(action) {
  if (!action || typeof action !== 'object') {
    return null;
  }
  const id = normalizeString(action.id);
  if (!['retry_with_rewritten_jql', 'ask_user_for_search_input', 'not_recoverable', 'submit_supplement'].includes(id)) {
    return null;
  }
  return {
    id,
    label: normalizeString(action.label) || id,
    style: ['primary', 'secondary'].includes(action.style) ? action.style : (id === 'submit_supplement' ? 'primary' : 'secondary'),
    requiresConfirmation: action.requiresConfirmation === true
  };
}

function normalizeJiraSearchRecoverySupplement(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const inputs = Array.isArray(value.inputs) ? value.inputs.map((input) => {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const id = normalizeString(input.id);
    if (!id) {
      return null;
    }
    return {
      id,
      type: ['text', 'select'].includes(input.type) ? input.type : 'text',
      label: normalizeString(input.label) || id,
      required: input.required === true,
      options: Array.isArray(input.options) ? input.options.map(normalizeString).filter(Boolean).slice(0, 20) : []
    };
  }).filter(Boolean).slice(0, 10) : [];
  return {
    prompt: normalizeString(value.prompt) || '请补充 Jira 查询条件。',
    inputs,
    actions: Array.isArray(value.actions) ? value.actions.map(normalizeJiraSearchRecoveryAction).filter((action) => action && action.id === 'submit_supplement').slice(0, 5) : []
  };
}

function parseClaudeCodeJiraSearchRecovery(output) {
  const parsed = extractJsonProposal(output);
  if (!parsed || typeof parsed !== 'object') {
    throw proposalError('Claude Code 没有返回有效 Jira 搜索恢复意图。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (parsed.kind !== 'jira_search_recovery' || parsed.plugin !== 'jira') {
    throw proposalError('Claude Code 返回了不支持的 Jira 搜索恢复类型。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const status = normalizeString(parsed.status);
  if (!['retry_available', 'needs_user_input', 'not_recoverable'].includes(status)) {
    throw proposalError('Claude Code 返回了不支持的 Jira 搜索恢复状态。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const action = normalizeJiraSearchRecoveryAction(parsed.action);
  if (!action) {
    throw proposalError('Claude Code 没有生成可用的 Jira 搜索恢复动作。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'retry_available' && action.id !== 'retry_with_rewritten_jql') {
    throw proposalError('Claude Code Jira 搜索恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'needs_user_input' && action.id !== 'ask_user_for_search_input') {
    throw proposalError('Claude Code Jira 搜索恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'not_recoverable' && action.id !== 'not_recoverable') {
    throw proposalError('Claude Code Jira 搜索恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const retryJql = parsed.retry && normalizeString(parsed.retry.jql);
  if (status === 'retry_available' && !retryJql) {
    throw proposalError('Claude Code 没有生成可重试的 Jira JQL。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  return {
    status,
    analyzedBy: 'claude_code',
    analyzedAt: new Date().toISOString(),
    summary: normalizeString(parsed.summary) || 'Claude Code 已分析 Jira 搜索失败。',
    reason: normalizeString(parsed.reason),
    action,
    retry: retryJql ? { jql: retryJql } : undefined,
    supplement: normalizeJiraSearchRecoverySupplement(parsed.supplement)
  };
}

function parseClaudeCodeJiraWriteRecovery(output) {
  const parsed = extractJsonProposal(output);
  if (!parsed || typeof parsed !== 'object') {
    throw proposalError('Claude Code 没有返回有效 Jira 写入恢复意图。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (parsed.kind !== 'jira_write_recovery' || parsed.plugin !== 'jira') {
    throw proposalError('Claude Code 返回了不支持的 Jira 写入恢复类型。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const status = normalizeString(parsed.status);
  if (!['retry_available', 'needs_user_input', 'not_recoverable'].includes(status)) {
    throw proposalError('Claude Code 返回了不支持的 Jira 写入恢复状态。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const action = parsed.action && typeof parsed.action === 'object'
    ? {
        id: normalizeString(parsed.action.id),
        label: normalizeString(parsed.action.label) || normalizeString(parsed.action.id),
        requiresConfirmation: parsed.action.requiresConfirmation === true
      }
    : null;
  if (!action || !['retry_with_unchanged_payload', 'ask_user_for_input', 'not_recoverable'].includes(action.id)) {
    throw proposalError('Claude Code 没有生成可用的 Jira 写入恢复动作。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'retry_available' && action.id !== 'retry_with_unchanged_payload') {
    throw proposalError('Claude Code Jira 写入恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'needs_user_input' && action.id !== 'ask_user_for_input') {
    throw proposalError('Claude Code Jira 写入恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'not_recoverable' && action.id !== 'not_recoverable') {
    throw proposalError('Claude Code Jira 写入恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  return {
    status,
    analyzedBy: 'claude_code',
    analyzedAt: new Date().toISOString(),
    summary: normalizeString(parsed.summary) || 'Claude Code 已分析 Jira 写入失败。',
    reason: normalizeString(parsed.reason),
    action,
    supplement: parsed.supplement && typeof parsed.supplement === 'object' ? parsed.supplement : undefined
  };
}

function normalizeRecoveryAction(action) {
  if (!action || typeof action !== 'object') {
    return null;
  }
  const id = normalizeString(action.id);
  if (!['retry_without_labels', 'cancel', 'submit_supplement'].includes(id)) {
    return null;
  }
  return {
    id,
    kind: normalizeString(action.kind) || (id === 'cancel' ? 'cancel' : 'safe_retry'),
    label: normalizeString(action.label) || id,
    style: ['primary', 'secondary'].includes(action.style) ? action.style : (id === 'retry_without_labels' ? 'primary' : 'secondary'),
    requiresConfirmation: action.requiresConfirmation !== false && id !== 'cancel',
    riskLevel: normalizeString(action.riskLevel) || 'low',
    description: normalizeString(action.description)
  };
}

function normalizeRecoverySupplement(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const inputs = Array.isArray(value.inputs) ? value.inputs.map((input) => {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const id = normalizeString(input.id);
    if (!id) {
      return null;
    }
    return {
      id,
      type: ['text', 'select'].includes(input.type) ? input.type : 'text',
      label: normalizeString(input.label) || id,
      required: input.required === true,
      options: Array.isArray(input.options) ? input.options.map(normalizeString).filter(Boolean).slice(0, 20) : []
    };
  }).filter(Boolean).slice(0, 10) : [];
  return {
    prompt: normalizeString(value.prompt) || '请补充信息。',
    inputs,
    actions: Array.isArray(value.actions) ? value.actions.map(normalizeRecoveryAction).filter(Boolean).slice(0, 5) : []
  };
}

function normalizeExecutionRecoveryAction(action) {
  if (!action || typeof action !== 'object') {
    return null;
  }
  const id = normalizeString(action.id);
  if (![
    'retry_with_strict_command_template',
    'retry_with_node_template',
    'retry_with_python_template',
    'server_extract_attachment_then_retry',
    'ask_user_for_missing_input',
    'not_recoverable',
    'cancel'
  ].includes(id)) {
    return null;
  }
  return {
    id,
    label: normalizeString(action.label) || id,
    requiresConfirmation: action.requiresConfirmation === true
  };
}

function parseClaudeCodeExecutionRecovery(output, { stage, expectedKind } = {}) {
  const parsed = extractJsonProposal(output);
  if (!parsed || typeof parsed !== 'object') {
    throw proposalError('Claude Code 没有返回有效执行恢复意图。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (parsed.kind !== 'claude_code_execution_recovery') {
    throw proposalError('Claude Code 返回了不支持的执行恢复类型。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (stage && parsed.stage && parsed.stage !== stage) {
    throw proposalError('Claude Code 执行恢复阶段不匹配。', 'CLAUDE_CODE_INTENT_MISMATCH');
  }
  if (expectedKind && parsed.expectedKind && parsed.expectedKind !== expectedKind) {
    throw proposalError('Claude Code 执行恢复预期结果不匹配。', 'CLAUDE_CODE_INTENT_MISMATCH');
  }
  const status = normalizeString(parsed.status);
  if (!['retry_available', 'needs_user_input', 'not_recoverable'].includes(status)) {
    throw proposalError('Claude Code 返回了不支持的执行恢复状态。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const action = normalizeExecutionRecoveryAction(parsed.action);
  if (!action) {
    throw proposalError('Claude Code 没有生成可用的执行恢复动作。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (status === 'retry_available' && !['retry_with_strict_command_template', 'retry_with_node_template', 'retry_with_python_template', 'server_extract_attachment_then_retry'].includes(action.id)) {
    throw proposalError('Claude Code 执行恢复动作与状态不匹配。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  return {
    status,
    analyzedBy: 'claude_code',
    analyzedAt: new Date().toISOString(),
    stage: normalizeString(parsed.stage) || stage,
    expectedKind: normalizeString(parsed.expectedKind) || expectedKind,
    summary: normalizeString(parsed.summary) || 'Claude Code 已分析执行失败。',
    reason: normalizeString(parsed.reason),
    action
  };
}

function parseClaudeCodePluginOperationRecovery(output, operation) {
  const parsed = extractJsonProposal(output);
  if (!parsed || typeof parsed !== 'object') {
    throw proposalError('Claude Code 没有返回有效插件恢复意图。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  if (parsed.kind !== 'plugin_operation_recovery' || parsed.operationId !== (operation && operation.id)) {
    throw proposalError('Claude Code 插件恢复意图与当前操作不匹配。', 'CLAUDE_CODE_INTENT_MISMATCH');
  }
  if (parsed.plugin !== 'jira') {
    throw proposalError('Claude Code 返回了不支持的插件恢复类型。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const status = normalizeString(parsed.status);
  if (!['available', 'needs_user_input', 'not_recoverable'].includes(status)) {
    throw proposalError('Claude Code 返回了不支持的插件恢复状态。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  const actions = Array.isArray(parsed.actions) ? parsed.actions.map(normalizeRecoveryAction).filter(Boolean).slice(0, 5) : [];
  if (actions.length === 0) {
    throw proposalError('Claude Code 没有生成可选择的恢复动作。', 'CLAUDE_CODE_INTENT_INVALID');
  }
  return {
    status,
    analyzedBy: 'claude_code',
    analyzedAt: new Date().toISOString(),
    summary: normalizeString(parsed.summary) || 'Claude Code 已分析插件操作错误。',
    reason: normalizeString(parsed.reason),
    actions,
    supplement: normalizeRecoverySupplement(parsed.supplement)
  };
}

function buildPromptForMode(permissionMode, input) {
  if (permissionMode === 'write_proposal') {
    return buildClaudeCodeWriteProposalPrompt(input);
  }
  if (permissionMode === 'operation_intent') {
    return buildClaudeCodeOperationIntentPrompt(input);
  }
  if (permissionMode === 'confirmed_operation_intent') {
    return buildClaudeCodeConfirmedOperationPrompt(input);
  }
  if (permissionMode === 'plugin_operation_error_analysis') {
    return buildClaudeCodePluginOperationErrorPrompt(input);
  }
  if (permissionMode === 'claude_code_execution_error_analysis') {
    return buildClaudeCodeExecutionErrorAnalysisPrompt(input, input.executionFailure || {});
  }
  if (permissionMode === 'jira_search_error_analysis') {
    return buildClaudeCodeJiraSearchErrorAnalysisPrompt(input);
  }
  if (permissionMode === 'jira_write_error_analysis') {
    return buildClaudeCodeJiraWriteErrorAnalysisPrompt(input);
  }
  return buildClaudeCodePrompt(input);
}

async function runClaudeCodeTask(input = {}) {
  const {
    permissionMode = 'read_only',
    runner = defaultReadOnlyRunner,
    claudeCodeConfig,
    onDelta,
    onEvent,
    onTiming
  } = input;

  if (!['read_only', 'write_proposal', 'operation_intent', 'confirmed_operation_intent', 'plugin_operation_error_analysis', 'claude_code_execution_error_analysis', 'jira_search_error_analysis', 'jira_write_error_analysis', 'bug_analysis_workspace'].includes(permissionMode)) {
    const error = new Error('Claude Code 当前不允许这个权限模式。');
    error.code = 'CLAUDE_CODE_PERMISSION_DENIED';
    error.statusCode = 403;
    error.publicMessage = error.message;
    throw error;
  }

  if (typeof onEvent === 'function') {
    onEvent({
      type: 'status',
      message: permissionMode === 'write_proposal'
        ? '白泽正在调用 Claude Code 生成补丁草案。'
        : permissionMode === 'bug_analysis_workspace'
          ? '白泽正在调用 Claude Code 在授权 BUG 分析目录内处理工程分析。'
          : '白泽正在调用 Claude Code 只读分析。'
    });
  }

  const preparedInput = await collectClaudeCodeContext({ ...input, permissionMode, claudeCodeConfig });
  const prompt = buildPromptForMode(permissionMode, preparedInput);
  const startedAt = Date.now();
  const reply = await runner({
    ...preparedInput,
    prompt,
    permissionMode,
    claudeCodeConfig
  });

  if (typeof onTiming === 'function') {
    onTiming('claudeCodeMs', Date.now() - startedAt);
  }

  if (permissionMode === 'write_proposal') {
    return parseClaudeCodePatchProposal(reply);
  }

  if (permissionMode === 'operation_intent') {
    const requireJiraBulkCreate = isJiraCreateOperationIntent(input);
    try {
      return parseClaudeCodeOperationIntent(reply, { requireJiraBulkCreate });
    } catch (error) {
      let executionRecovery = null;
      if (requireJiraBulkCreate) {
        if (typeof onEvent === 'function') {
          onEvent({
            type: 'status',
            message: '白泽正在让 Claude Code 分析自己的执行失败。'
          });
        }
        if (typeof onTiming === 'function') {
          onTiming('claudeCodeExecutionRecoveryAttempted', 1);
        }
        const analysisStartedAt = Date.now();
        try {
          const recoveryReply = await runner({
            ...input,
            prompt: buildClaudeCodeExecutionErrorAnalysisPrompt(input, {
              stage: 'operation_intent',
              expectedKind: 'jira_bulk_create',
              originalOutput: reply,
              errorMessage: error.publicMessage || error.message
            }),
            permissionMode: 'claude_code_execution_error_analysis',
            claudeCodeConfig
          });
          executionRecovery = parseClaudeCodeExecutionRecovery(recoveryReply, {
            stage: 'operation_intent',
            expectedKind: 'jira_bulk_create'
          });
          if (typeof onTiming === 'function') {
            onTiming('claudeCodeExecutionRecoveryMs', Date.now() - analysisStartedAt);
          }
        } catch (recoveryError) {
          if (typeof onTiming === 'function') {
            onTiming('claudeCodeExecutionRecoveryFailed', 1);
          }
          executionRecovery = {
            status: 'retry_available',
            summary: recoveryError.publicMessage || recoveryError.message,
            action: { id: 'retry_with_strict_command_template' }
          };
        }
        if (executionRecovery.status !== 'retry_available') {
          throw proposalError(executionRecovery.summary || 'Claude Code 执行失败，当前无法自动恢复。', 'CLAUDE_CODE_EXECUTION_NOT_RECOVERABLE');
        }
      }
      if (typeof onEvent === 'function') {
        onEvent({
          type: 'status',
          message: requireJiraBulkCreate ? '白泽正在按 Claude Code 自诊断结果重试。' : '白泽正在让 Claude Code 修复操作意图格式。'
        });
      }
      if (typeof onTiming === 'function') {
        onTiming('claudeCodeRepairAttempted', 1);
      }
      const repairStartedAt = Date.now();
      const repairedReply = await runner({
        ...input,
        prompt: requireJiraBulkCreate
          ? buildClaudeCodeJiraCreateIntentRetryPrompt(input, {
            originalOutput: reply,
            errorMessage: error.publicMessage || error.message,
            recovery: executionRecovery
          })
          : buildClaudeCodeOperationIntentRepairPrompt({
            originalOutput: reply,
            errorMessage: error.publicMessage || error.message
          }),
        permissionMode,
        claudeCodeConfig
      });
      if (typeof onTiming === 'function') {
        onTiming('claudeCodeRepairMs', Date.now() - repairStartedAt);
      }
      return parseClaudeCodeOperationIntent(repairedReply, { requireJiraBulkCreate });
    }
  }

  if (permissionMode === 'confirmed_operation_intent') {
    return parseClaudeCodeConfirmedOperationIntent(reply, input.operation);
  }

  if (permissionMode === 'claude_code_execution_error_analysis') {
    return parseClaudeCodeExecutionRecovery(reply, input.executionFailure || {});
  }

  if (permissionMode === 'jira_search_error_analysis') {
    return parseClaudeCodeJiraSearchRecovery(reply);
  }

  if (permissionMode === 'jira_write_error_analysis') {
    return parseClaudeCodeJiraWriteRecovery(reply);
  }

  if (permissionMode === 'plugin_operation_error_analysis') {
    try {
      return parseClaudeCodePluginOperationRecovery(reply, input.operation);
    } catch (error) {
      if (typeof onEvent === 'function') {
        onEvent({
          type: 'status',
          message: '白泽正在让 Claude Code 修复插件恢复选项格式。'
        });
      }
      if (typeof onTiming === 'function') {
        onTiming('claudeCodeRecoveryRepairAttempted', 1);
      }
      const repairStartedAt = Date.now();
      const repairedReply = await runner({
        ...input,
        prompt: buildClaudeCodePluginOperationRecoveryRepairPrompt({
          originalOutput: reply,
          errorMessage: error.publicMessage || error.message,
          operation: input.operation
        }),
        permissionMode,
        claudeCodeConfig
      });
      if (typeof onTiming === 'function') {
        onTiming('claudeCodeRecoveryRepairMs', Date.now() - repairStartedAt);
      }
      return parseClaudeCodePluginOperationRecovery(repairedReply, input.operation);
    }
  }

  const finalReply = typeof reply === 'string' && reply.trim() !== ''
    ? reply.trim()
    : '白泽：Claude Code 没有返回有效结果。';

  if (typeof onDelta === 'function') {
    onDelta(finalReply);
  }

  return finalReply;
}

module.exports = {
  buildClaudeCodePrompt,
  buildClaudeCodeWriteProposalPrompt,
  buildClaudeCodeOperationIntentPrompt,
  buildClaudeCodeConfirmedOperationPrompt,
  buildClaudeCodePluginOperationErrorPrompt,
  buildClaudeCodeExecutionErrorAnalysisPrompt,
  buildClaudeCodeJiraSearchErrorAnalysisPrompt,
  buildClaudeCodeJiraWriteErrorAnalysisPrompt,
  buildClaudeCodeEnv,
  createClaudeCodeCliRunner,
  parseClaudeCodePatchProposal,
  parseClaudeCodeOperationIntent,
  parseClaudeCodeConfirmedOperationIntent,
  parseClaudeCodePluginOperationRecovery,
  parseClaudeCodeExecutionRecovery,
  parseClaudeCodeJiraSearchRecovery,
  parseClaudeCodeJiraWriteRecovery,
  runClaudeCodeTask
};
