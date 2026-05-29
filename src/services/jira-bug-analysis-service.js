const crypto = require('crypto');
const path = require('path');
const childProcess = require('child_process');
const paths = require('../config/paths');
const { readJsonIfExists, writeJson } = require('../lib/file-store');
const { getClaudeCodeConfig, getJiraConfig } = require('./config-service');
const { addJiraComment, jiraError, requestJira, searchJira } = require('./jira-client-service');
const { runClaudeCodeTask } = require('./claude-code-service');

const BUG_ANALYSIS_MARKER = '<!-- baize:jira-bug-analysis -->';
const BUG_ANALYSIS_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const BUG_ANALYSIS_ITEM_TIMEOUT_MS = 60 * 60 * 1000;
const BUG_ANALYSIS_SVN_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const BUG_ANALYSIS_MAX_ATTEMPTS = 10;
const RECOVERY_ACTIONS = ['retry_analysis', 'skip_item', 'cancel_run'];
const TERMINAL_RUN_STATUSES = ['completed', 'cancelled', 'timed_out', 'superseded'];
const activeBugAnalysisRuns = new Map();
let activeBugAnalysisItem = null;

function analysisScope(options = {}) {
  return path.resolve(options.baizeRoot || paths.BAIZE_ROOT);
}

function activeRunKey(runId, options = {}) {
  return `${analysisScope(options)}:${runId}`;
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function getStorePaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'runtime', 'bug-analysis');
  return {
    root,
    indexFile: path.join(root, 'index.json')
  };
}

async function readIndex(baizeRoot) {
  return readJsonIfExists(getStorePaths(baizeRoot).indexFile, { jobs: [], runs: [] });
}

async function writeIndex(index, baizeRoot) {
  const store = getStorePaths(baizeRoot);
  await writeJson(store.indexFile, index, store.root);
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function quoteJqlValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildBugJql(input = {}) {
  const explicitJql = readString(input.jql);
  if (explicitJql) {
    return explicitJql;
  }
  const projectKey = readString(input.projectKey);
  if (!projectKey) {
    throw jiraError('请提供 Jira 项目 Key 或 JQL。');
  }
  return `project = ${quoteJqlValue(projectKey)} AND issuetype = Bug ORDER BY updated DESC`;
}

function simplifyBugIssue(issue = {}) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    id: issue.id,
    summary: fields.summary || '',
    description: fields.description || '',
    status: fields.status && fields.status.name ? fields.status.name : '',
    assignee: fields.assignee && fields.assignee.displayName ? fields.assignee.displayName : null,
    reporter: fields.reporter && fields.reporter.displayName ? fields.reporter.displayName : null,
    priority: fields.priority && fields.priority.name ? fields.priority.name : null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    created: fields.created || null,
    updated: fields.updated || null
  };
}

function sanitizeRun(run) {
  return run || null;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getRunTimeoutMs(run = {}) {
  return Number.isInteger(run.timeoutMs) && run.timeoutMs > 0 ? run.timeoutMs : BUG_ANALYSIS_TIMEOUT_MS;
}

function getItemTimeoutMs(run = {}) {
  return Number.isInteger(run.itemTimeoutMs) && run.itemTimeoutMs > 0 ? run.itemTimeoutMs : BUG_ANALYSIS_ITEM_TIMEOUT_MS;
}

function getMaxAttempts(run = {}) {
  return Number.isInteger(run.maxAttempts) && run.maxAttempts > 0 ? run.maxAttempts : BUG_ANALYSIS_MAX_ATTEMPTS;
}

function buildDeadline(now = new Date(), timeoutMs = BUG_ANALYSIS_TIMEOUT_MS) {
  return nowIso(new Date(now.getTime() + timeoutMs));
}

function isDueAt(value, now = new Date()) {
  const timestamp = parseTimestamp(value);
  return timestamp === null || timestamp <= now.getTime();
}

function getRemainingRunMs(run = {}, now = new Date()) {
  const deadline = parseTimestamp(run.deadlineAt);
  if (deadline === null) {
    return getRunTimeoutMs(run);
  }
  return Math.max(0, deadline - now.getTime());
}

function isRunDeadlineExceeded(run = {}, now = new Date()) {
  return getRemainingRunMs(run, now) <= 0;
}

function normalizeIssueKeys(keys = []) {
  return [...new Set(keys.map(readString).filter(Boolean).map((key) => key.toUpperCase()))].sort();
}

function runIssueKeySignature(run = {}) {
  return normalizeIssueKeys((run.items || []).map((item) => item.issueKey)).join('|');
}

function isTerminalRun(run = {}) {
  return TERMINAL_RUN_STATUSES.includes(run.status);
}

function isAutoRetryableRecoveryItem(item = {}, run = {}) {
  const actions = item.recovery && Array.isArray(item.recovery.actions) ? item.recovery.actions : [];
  return item.status === 'recovery_required'
    && (item.attempt || 0) < getMaxAttempts(run)
    && actions.some((action) => action && action.id === 'retry_analysis');
}

function countItems(items = []) {
  return {
    completed: items.filter((item) => item.status === 'completed').length,
    failed: items.filter((item) => item.status === 'recovery_required' || item.status === 'failed').length,
    awaiting: items.filter((item) => item.status === 'awaiting_comment_confirmation').length,
    pending: items.filter((item) => item.status === 'pending').length,
    analyzing: items.filter((item) => item.status === 'analyzing').length
  };
}

function settleRun(run = {}, now = new Date()) {
  if (isTerminalRun(run)) {
    return run;
  }
  const items = Array.isArray(run.items) ? run.items : [];
  const counts = countItems(items);
  let status = run.status;
  if (items.length > 0 && items.every((item) => item.status === 'completed' || item.status === 'skipped')) {
    status = 'completed';
  } else if (counts.failed > 0) {
    status = 'partial_failed';
  } else if (counts.awaiting > 0 && counts.pending === 0 && counts.analyzing === 0) {
    status = 'awaiting_comment_confirmation';
  } else if (['awaiting_comment_confirmation', 'partial_failed'].includes(status) && (counts.pending > 0 || counts.analyzing > 0)) {
    status = 'running';
  }
  return {
    ...run,
    status,
    completed: counts.completed,
    failed: counts.failed,
    finishedAt: TERMINAL_RUN_STATUSES.includes(status) ? (run.finishedAt || nowIso(now)) : run.finishedAt || null
  };
}

function buildAnalysisPrompt({ run, item, issue, svnMaintenance }) {
  return [
    '你是白泽的 Jira Bug 工程分析员。',
    '服务器已在启动本 BUG 子任务前执行受控 SVN 维护；你必须基于下方 SVN 维护结果和当前工程文件分析，不要再次执行 svn cleanup 或 svn update。',
    '本流程只允许分析和只读查询；除服务器已执行的 SVN 维护外，不允许创建、修改或删除任何工程文件、分析文件或临时文件。',
    '如果 SVN 维护结果显示更新或冲突处理失败，仍必须基于当前可读取的工程工作副本继续进行工程级分析，并明确标注 SVN 更新失败原因、当前分析依据来自未完成更新的本地工程状态。',
    '只要当前工程工作副本可读取，就禁止写“无法完成工程级分析”“暂不能给出工程结论”“只能待工程分析”这类放弃分析的表述；应给出带限制说明的工程分析结论。',
    '请分析这个 Bug 的可能原因、相关模块、建议排查路径、风险和下一步处理建议。',
    '输出中文 Markdown，结论要能直接作为 Jira 评论草稿，并标明 SVN 维护结果和工程依据来源。',
    '',
    'SVN 维护结果：',
    svnMaintenance || '未提供。',
    '',
    `Run ID：${run.id}`,
    `Jira：${item.issueKey}`,
    `标题：${issue.summary || item.summary || ''}`,
    `状态：${issue.status || ''}`,
    `优先级：${issue.priority || ''}`,
    `负责人：${issue.assignee || ''}`,
    `标签：${(issue.labels || []).join(', ')}`,
    '',
    '描述：',
    issue.description || '无描述。'
  ].join('\n');
}

function buildCommentDraft(analysis, item) {
  return `${BUG_ANALYSIS_MARKER}\n白泽 Claude Code 工程级 BUG 分析（${item.issueKey}）：\n\n${analysis}`;
}

function buildSvnArgs(args, svnConfig = {}) {
  const fullArgs = ['--non-interactive', '--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other', ...args];
  if (readString(svnConfig.username)) {
    fullArgs.push('--username', readString(svnConfig.username));
  }
  if (readString(svnConfig.password)) {
    fullArgs.push('--password', readString(svnConfig.password));
  }
  return fullArgs;
}

function runSvn(args, options = {}) {
  const timeoutMs = options.timeoutMs || BUG_ANALYSIS_SVN_UPDATE_TIMEOUT_MS;
  return new Promise((resolve) => {
    childProcess.execFile('svn', buildSvnArgs(args, options.svn), {
      cwd: options.cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: error && typeof error.code !== 'undefined' ? error.code : 0,
        signal: error && error.signal ? error.signal : null,
        timedOut: Boolean(error && error.killed),
        stdout,
        stderr
      });
    });
  });
}

function truncateSvnOutput(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length <= 80) {
    return lines.join('\n');
  }
  return [...lines.slice(0, 40), '...', ...lines.slice(-40)].join('\n');
}

function summarizeSvnStep(label, result) {
  return [
    `${label}：${result.ok ? '成功' : '失败'}${result.timedOut ? '（10 分钟超时）' : ''}`,
    result.stdout ? truncateSvnOutput(result.stdout) : '',
    result.stderr ? truncateSvnOutput(result.stderr) : ''
  ].filter(Boolean).join('\n');
}

async function runBugAnalysisSvnMaintenance(workspacePath, svnConfig = {}) {
  const cleanup = await runSvn(['cleanup', workspacePath], { cwd: workspacePath, timeoutMs: BUG_ANALYSIS_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  if (!cleanup.ok) {
    return summarizeSvnStep('svn cleanup', cleanup);
  }

  const preResolve = await runSvn(['resolve', '--accept', 'theirs-full', '-R', workspacePath], { cwd: workspacePath, timeoutMs: BUG_ANALYSIS_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  const update = await runSvn(['update', '--accept', 'theirs-full', workspacePath], { cwd: workspacePath, timeoutMs: BUG_ANALYSIS_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  const postResolve = await runSvn(['resolve', '--accept', 'theirs-full', '-R', workspacePath], { cwd: workspacePath, timeoutMs: BUG_ANALYSIS_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  const status = await runSvn(['status', workspacePath], { cwd: workspacePath, timeoutMs: 2 * 60 * 1000, svn: svnConfig });
  return [
    summarizeSvnStep('svn cleanup', cleanup),
    summarizeSvnStep('svn resolve --accept theirs-full -R', preResolve),
    summarizeSvnStep('svn update --accept theirs-full', update),
    summarizeSvnStep('svn resolve --accept theirs-full -R', postResolve),
    summarizeSvnStep('svn status', status)
  ].join('\n\n');
}

function validateEngineeringAnalysis(analysis) {
  const text = String(analysis || '');
  const hasSvn = /(svn\s+update|SVN\s*更新|svn更新|已完成\s*SVN|执行\s*SVN)/i.test(text);
  const hasEvidenceWord = /(工程依据|相关文件|证据|模块|配置|资源|日志|路径)/i.test(text);
  const hasPath = /([A-Za-z]:[\\/][^\s，。；]+|\b(?:Assets|src|client|server|baize|tests|config)[\\/][^\s，。；]+|\b[^\s，。；]+\.(?:js|cjs|ts|tsx|cs|json|yaml|yml|prefab|lua|asset|bytes|md)\b)/i.test(text);
  const givesUpOnSvnFailure = /(无法完成(?:有效的)?工程级|无法完成工程级结论|暂不能给出工程|不能给出(?:可靠的)?工程|待工程分析|不能基于.*本地文件给出|不能.*工程级分析)/i.test(text);
  return hasSvn && hasEvidenceWord && hasPath && !givesUpOnSvnFailure;
}

function evidenceError() {
  const error = new Error('BUG 分析缺少 SVN 更新结果、工程依据，或在本地工程可读时放弃工程分析，未生成 Jira 评论草稿。');
  error.code = 'MISSING_ENGINEERING_EVIDENCE';
  error.statusCode = 422;
  error.publicMessage = error.message;
  return error;
}

function itemTimeoutError(timeoutMs = BUG_ANALYSIS_ITEM_TIMEOUT_MS) {
  const minutes = Math.round(timeoutMs / 60000);
  const error = new Error(`单个 BUG 分析超过 ${minutes} 分钟超时时间，已废弃本次分析。`);
  error.code = 'BUG_ANALYSIS_ITEM_TIMEOUT';
  error.statusCode = 504;
  error.publicMessage = error.message;
  return error;
}

function buildBugIssueJql(issueKeys = []) {
  const keys = issueKeys.map(readString).filter(Boolean);
  if (keys.length === 0) {
    throw jiraError('请提供 Jira Bug 单号。');
  }
  return `key in (${keys.map(quoteJqlValue).join(', ')}) AND issuetype = Bug ORDER BY key ASC`;
}

function withBugAnalysisTimeout(claudeCodeConfig = {}, timeoutMs = BUG_ANALYSIS_TIMEOUT_MS) {
  return {
    ...claudeCodeConfig,
    timeoutMs,
    bugAnalysisTimeoutMs: timeoutMs,
    workspacePath: claudeCodeConfig.bugAnalysisWorkspacePath || claudeCodeConfig.workspacePath
  };
}

function parseRecoveryActions(output) {
  try {
    const parsed = JSON.parse(String(output || '').trim());
    if (parsed.kind !== 'jira_bug_analysis_recovery') {
      return null;
    }
    const actions = Array.isArray(parsed.actions) ? parsed.actions.map((action) => {
      const id = readString(action && action.id);
      if (!RECOVERY_ACTIONS.includes(id)) {
        return null;
      }
      return {
        id,
        label: readString(action.label) || id,
        requiresConfirmation: action.requiresConfirmation !== false,
        description: readString(action.description)
      };
    }).filter(Boolean) : [];
    return {
      status: actions.length > 0 ? 'available' : 'not_recoverable',
      analyzedBy: 'claude_code',
      analyzedAt: nowIso(),
      summary: readString(parsed.summary) || 'Claude Code 已分析 Bug 处理失败。',
      reason: readString(parsed.reason),
      actions
    };
  } catch {
    return null;
  }
}

function buildRecoveryPrompt({ run, item, error }) {
  return [
    '请只做只读自诊断，分析白泽处理 Jira Bug 分析 Item 失败的原因，并输出恢复建议 JSON。',
    '服务器只会执行白名单动作：retry_analysis、skip_item、cancel_run。不要返回其他动作。',
    'JSON 格式：{"kind":"jira_bug_analysis_recovery","summary":"...","reason":"...","actions":[{"id":"retry_analysis","label":"重试分析","requiresConfirmation":false}]}',
    '',
    `Run ID：${run.id}`,
    `Item ID：${item.id}`,
    `Jira：${item.issueKey}`,
    `错误：${error.publicMessage || error.message || String(error)}`
  ].join('\n');
}

function buildDefaultRecovery(error) {
  const isItemTimeout = error && error.code === 'BUG_ANALYSIS_ITEM_TIMEOUT';
  return {
    status: 'available',
    analyzedBy: 'server',
    analyzedAt: nowIso(),
    summary: isItemTimeout ? 'Bug 分析进程超过 1 小时，已废弃本次分析。' : 'Bug 分析失败，可以重试或跳过该 Item。',
    reason: error.publicMessage || error.message || String(error),
    actions: isItemTimeout
      ? [
          { id: 'skip_item', label: '确认分析失败', requiresConfirmation: true },
          { id: 'cancel_run', label: '取消整批分析', requiresConfirmation: true }
        ]
      : [
          { id: 'retry_analysis', label: '重试分析', requiresConfirmation: false },
          { id: 'skip_item', label: '跳过这个 Bug', requiresConfirmation: true }
        ]
  };
}

async function createBugAnalysisRun(input = {}, options = {}) {
  const now = options.now || new Date();
  const config = await getJiraConfig(options);
  const issueKeys = Array.isArray(input.issueKeys) ? input.issueKeys.map(readString).filter(Boolean) : [];
  const jql = issueKeys.length > 0 ? buildBugIssueJql(issueKeys) : buildBugJql(input);
  const raw = await searchJira(config, {
    jql,
    maxResults: Number.isInteger(input.maxResults) && input.maxResults > 0 ? Math.min(input.maxResults, 200) : 100,
    fields: ['summary', 'status', 'assignee', 'reporter', 'priority', 'labels', 'created', 'updated'],
    fetchImpl: options.fetchImpl
  });
  const issues = Array.isArray(raw.issues) ? raw.issues.map(simplifyBugIssue) : [];
  const job = {
    id: `bug-job-${crypto.randomUUID()}`,
    kind: 'jira_bug_analysis_job',
    status: 'awaiting_confirmation',
    clientId: input.clientId || null,
    userId: input.userId || null,
    conversationId: input.conversationId || null,
    projectKey: readString(input.projectKey) || null,
    jql,
    scheduleAt: readString(input.scheduleAt) || nowIso(now),
    createdAt: nowIso(now),
    updatedAt: nowIso(now)
  };
  const run = {
    id: `bug-run-${crypto.randomUUID()}`,
    kind: 'jira_bug_analysis_run',
    jobId: job.id,
    clientId: input.clientId || null,
    userId: input.userId || null,
    conversationId: input.conversationId || null,
    status: 'awaiting_confirmation',
    jql,
    scheduleAt: job.scheduleAt,
    timeoutMs: BUG_ANALYSIS_TIMEOUT_MS,
    itemTimeoutMs: BUG_ANALYSIS_ITEM_TIMEOUT_MS,
    maxAttempts: BUG_ANALYSIS_MAX_ATTEMPTS,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
    total: issues.length,
    completed: 0,
    failed: 0,
    items: issues.map((issue) => ({
      id: `bug-item-${crypto.randomUUID()}`,
      status: 'pending',
      issueKey: issue.key,
      issueId: issue.id,
      summary: issue.summary,
      snapshot: issue,
      analysis: null,
      commentDraft: null,
      recovery: null,
      error: null,
      attempt: 0,
      analysisStartedAt: null,
      createdAt: nowIso(now),
      updatedAt: nowIso(now)
    })),
    createdAt: nowIso(now),
    updatedAt: nowIso(now)
  };
  const index = await readIndex(options.baizeRoot);
  index.jobs = [job, ...index.jobs];
  index.runs = [run, ...index.runs];
  await writeIndex(index, options.baizeRoot);
  return { job, run: sanitizeRun(run) };
}

async function getBugAnalysisRun(runId, options = {}) {
  const index = await readIndex(options.baizeRoot);
  const run = index.runs.find((item) => item.id === runId);
  if (!run) {
    throw jiraError('Bug 分析批次不存在。', 'NOT_FOUND', 404);
  }
  return sanitizeRun(run);
}

async function updateRun(runId, updater, options = {}) {
  const index = await readIndex(options.baizeRoot);
  const runIndex = index.runs.findIndex((item) => item.id === runId);
  if (runIndex === -1) {
    throw jiraError('Bug 分析批次不存在。', 'NOT_FOUND', 404);
  }
  const updated = updater(index.runs[runIndex]);
  const withUpdateTime = { ...settleRun(updated, options.now || new Date()), updatedAt: nowIso(options.now || new Date()) };
  index.runs[runIndex] = withUpdateTime;
  const jobIndex = index.jobs.findIndex((job) => job.id === index.runs[runIndex].jobId);
  if (jobIndex !== -1) {
    index.jobs[jobIndex] = { ...index.jobs[jobIndex], status: index.runs[runIndex].status, updatedAt: index.runs[runIndex].updatedAt };
  }
  await writeIndex(index, options.baizeRoot);
  return sanitizeRun(index.runs[runIndex]);
}

async function confirmBugAnalysisRun(runId, input = {}, options = {}) {
  return updateRun(runId, (run) => {
    if (run.status !== 'awaiting_confirmation') {
      throw jiraError('Bug 分析批次当前状态不能确认。', 'INVALID_RUN_STATUS', 409);
    }
    const now = options.now || new Date();
    const due = isDueAt(run.scheduleAt, now);
    return {
      ...run,
      status: due ? 'running' : 'scheduled',
      confirmedBy: input.clientId || input.userId || null,
      confirmedAt: nowIso(now),
      startedAt: due ? nowIso(now) : run.startedAt || null,
      deadlineAt: due ? buildDeadline(now, getRunTimeoutMs(run)) : run.deadlineAt || null,
      finishedAt: null
    };
  }, options);
}

async function activateDueBugAnalysisRuns(options = {}) {
  const now = options.now || new Date();
  const index = await readIndex(options.baizeRoot);
  const activated = [];
  index.runs = index.runs.map((run) => {
    if (run.status !== 'scheduled' || !isDueAt(run.scheduleAt, now)) {
      return run;
    }
    const updated = settleRun({
      ...run,
      status: 'running',
      startedAt: run.startedAt || nowIso(now),
      deadlineAt: run.deadlineAt || buildDeadline(now, getRunTimeoutMs(run)),
      updatedAt: nowIso(now)
    }, now);
    activated.push(updated);
    return updated;
  });
  for (const job of index.jobs) {
    if (activated.some((run) => run.jobId === job.id)) {
      job.status = 'running';
      job.updatedAt = nowIso(now);
    }
  }
  await writeIndex(index, options.baizeRoot);
  return activated.map(sanitizeRun);
}

async function fetchIssueDetails(issueKey, options = {}) {
  const config = await getJiraConfig(options);
  return simplifyBugIssue(await requestJira(config, `/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,assignee,reporter,priority,labels,created,updated`, {
    fetchImpl: options.fetchImpl
  }));
}

async function markRunTimedOut(runId, options = {}) {
  return updateRun(runId, (run) => ({ ...run, status: 'timed_out', finishedAt: nowIso(options.now || new Date()) }), options);
}

async function failBugAnalysisItem(runId, itemId, targetRun, targetItem, error, options = {}) {
  const latestRun = await getBugAnalysisRun(runId, options);
  if (isTerminalRun(latestRun)) {
    return latestRun;
  }

  const nextAttempt = targetItem.attempt || 0;
  const isItemTimeout = error && error.code === 'BUG_ANALYSIS_ITEM_TIMEOUT';
  const canAutoRetry = !isItemTimeout && nextAttempt < getMaxAttempts(targetRun);
  if (canAutoRetry) {
    return updateRun(runId, (run) => ({
      ...run,
      status: 'running',
      items: run.items.map((item) => item.id === itemId
        ? {
            ...item,
            status: 'pending',
            error: error.publicMessage || error.message || 'Bug 分析失败。',
            recovery: null,
            analysisStartedAt: null,
            lastAttemptFailedAt: nowIso(options.now || new Date()),
            updatedAt: nowIso(options.now || new Date())
          }
        : item)
    }), options);
  }

  let recovery = null;
  if (!isItemTimeout) {
    try {
      const claudeCodeConfig = await getClaudeCodeConfig(options);
      const recoveryTimeoutMs = Math.max(1000, Math.min(getRemainingRunMs(targetRun, options.now || new Date()), getItemTimeoutMs(targetRun)));
      const recoveryOutput = await runClaudeCodeTask({
        message: { text: buildRecoveryPrompt({ run: targetRun, item: targetItem, error }) },
        memoryQuery: [targetItem.issueKey, targetItem.summary, error.publicMessage || error.message || String(error)].filter(Boolean).join('\n'),
        permissionMode: 'bug_analysis_workspace',
        claudeCodeConfig: withBugAnalysisTimeout(claudeCodeConfig, recoveryTimeoutMs),
        runner: options.claudeCodeRunner
      });
      recovery = parseRecoveryActions(recoveryOutput);
    } catch {
      recovery = null;
    }
  }
  recovery = recovery || buildDefaultRecovery(error);
  return updateRun(runId, (run) => ({
    ...run,
    status: 'partial_failed',
    items: run.items.map((item) => item.id === itemId
      ? {
          ...item,
          status: 'recovery_required',
          error: `${error.publicMessage || error.message || 'Bug 分析失败。'}（已自动尝试 ${nextAttempt} 次）`,
          recovery,
          analysisStartedAt: null,
          updatedAt: nowIso(options.now || new Date())
        }
      : item)
  }), options);
}

async function analyzeBugAnalysisItem(runId, itemId, options = {}) {
  const scope = analysisScope(options);
  if (activeBugAnalysisItem && activeBugAnalysisItem.scope === scope && activeBugAnalysisItem.runId !== runId) {
    return getBugAnalysisRun(runId, options);
  }
  activeBugAnalysisItem = { scope, runId, itemId };
  try {
    return await analyzeBugAnalysisItemLocked(runId, itemId, options);
  } finally {
    if (activeBugAnalysisItem && activeBugAnalysisItem.scope === scope && activeBugAnalysisItem.runId === runId && activeBugAnalysisItem.itemId === itemId) {
      activeBugAnalysisItem = null;
    }
  }
}

async function analyzeBugAnalysisItemLocked(runId, itemId, options = {}) {
  const now = options.now || new Date();
  let targetItem;
  let targetRun = await updateRun(runId, (run) => {
    if (!['running', 'partial_failed', 'awaiting_comment_confirmation'].includes(run.status)) {
      throw jiraError('Bug 分析批次尚未进入运行状态。', 'INVALID_RUN_STATUS', 409);
    }
    if (isRunDeadlineExceeded(run, now)) {
      return { ...run, status: 'timed_out', finishedAt: nowIso(now) };
    }
    return {
      ...run,
      status: 'running',
      items: run.items.map((item) => {
        if (item.id !== itemId) {
          return item;
        }
        if (!['pending', 'failed', 'recovery_required'].includes(item.status)) {
          throw jiraError('Bug 分析 Item 当前状态不能分析。', 'INVALID_ITEM_STATUS', 409);
        }
        targetItem = {
          ...item,
          status: 'analyzing',
          attempt: (item.attempt || 0) + 1,
          analysisStartedAt: nowIso(now),
          updatedAt: nowIso(now)
        };
        return targetItem;
      })
    };
  }, options);
  if (targetRun.status === 'timed_out') {
    return targetRun;
  }
  if (!targetItem) {
    throw jiraError('Bug 分析 Item 不存在。', 'NOT_FOUND', 404);
  }

  try {
    const issue = await fetchIssueDetails(targetItem.issueKey, options);
    const claudeCodeConfig = await getClaudeCodeConfig(options);
    const workspacePath = claudeCodeConfig.bugAnalysisWorkspacePath || claudeCodeConfig.workspacePath;
    const svnMaintenance = await runBugAnalysisSvnMaintenance(workspacePath, claudeCodeConfig.svn);
    const timeoutMs = Math.max(1000, Math.min(getRemainingRunMs(targetRun, new Date()), getItemTimeoutMs(targetRun), claudeCodeConfig.bugAnalysisTimeoutMs || BUG_ANALYSIS_TIMEOUT_MS));
    const analysis = await runClaudeCodeTask({
      message: { text: buildAnalysisPrompt({ run: targetRun, item: targetItem, issue, svnMaintenance }) },
      memoryQuery: [targetItem.issueKey, issue.summary, issue.description, (issue.labels || []).join(' ')].filter(Boolean).join('\n'),
      permissionMode: 'bug_analysis_workspace',
      claudeCodeConfig: withBugAnalysisTimeout(claudeCodeConfig, timeoutMs),
      runner: options.claudeCodeRunner
    });
    if (!validateEngineeringAnalysis(analysis)) {
      throw evidenceError();
    }
    return updateRun(runId, (run) => ({
      ...run,
      items: run.items.map((item) => item.id === itemId
        ? {
            ...item,
            status: 'awaiting_comment_confirmation',
            snapshot: issue,
            analysis,
            commentDraft: buildCommentDraft(analysis, item),
            recovery: null,
            error: null,
            analysisStartedAt: null,
            updatedAt: nowIso(options.now || new Date())
          }
        : item)
    }), options);
  } catch (error) {
    const failedAt = options.now || new Date();
    const startedAt = parseTimestamp(targetItem.analysisStartedAt);
    const timedOut = (error && error.code === 'CLAUDE_CODE_TIMEOUT') || (startedAt !== null && startedAt + getItemTimeoutMs(targetRun) <= failedAt.getTime());
    return failBugAnalysisItem(runId, itemId, targetRun, targetItem, timedOut ? itemTimeoutError(getItemTimeoutMs(targetRun)) : error, options);
  }
}

async function processNextBugAnalysisItem(runId, options = {}) {
  const run = await getBugAnalysisRun(runId, options);
  if (isTerminalRun(run)) {
    return run;
  }
  if (isRunDeadlineExceeded(run, options.now || new Date())) {
    return markRunTimedOut(runId, options);
  }
  const nextItem = run.items.find((item) => item.status === 'pending');
  if (!nextItem) {
    return updateRun(runId, (current) => current, options);
  }
  return analyzeBugAnalysisItem(runId, nextItem.id, options);
}

async function recoverStaleAnalyzingRun(runId, options = {}) {
  const now = options.now || new Date();
  return updateRun(runId, (run) => ({
    ...run,
    status: run.items.some((item) => {
      const startedAt = parseTimestamp(item.analysisStartedAt || item.updatedAt);
      return item.status === 'analyzing' && (startedAt === null || startedAt + getItemTimeoutMs(run) <= now.getTime());
    }) ? 'partial_failed' : run.status,
    items: run.items.map((item) => {
      if (item.status !== 'analyzing') {
        return item;
      }
      const startedAt = parseTimestamp(item.analysisStartedAt || item.updatedAt);
      const stale = startedAt === null || startedAt + getItemTimeoutMs(run) <= now.getTime();
      if (!stale && !options.forceRecoverAnalyzing) {
        return item;
      }
      const error = itemTimeoutError(getItemTimeoutMs(run));
      return {
        ...item,
        status: 'recovery_required',
        analysisStartedAt: null,
        error: error.publicMessage,
        recovery: buildDefaultRecovery(error),
        updatedAt: nowIso(now)
      };
    })
  }), options);
}

async function runBugAnalysisLoop(runId, options = {}) {
  try {
    while (true) {
      await recoverStaleAnalyzingRun(runId, options);
      const run = await getBugAnalysisRun(runId, options);
      if (isTerminalRun(run) || ['awaiting_confirmation', 'scheduled'].includes(run.status)) {
        return run;
      }
      if (isRunDeadlineExceeded(run, new Date())) {
        return markRunTimedOut(runId, options);
      }
      if (!run.items.some((item) => item.status === 'pending')) {
        return updateRun(runId, (current) => current, options);
      }
      await processNextBugAnalysisItem(runId, options);
    }
  } finally {
    activeBugAnalysisRuns.delete(activeRunKey(runId, options));
  }
}

async function enqueueBugAnalysisRun(runId, options = {}) {
  let run = await getBugAnalysisRun(runId, options);
  if (['partial_failed', 'awaiting_comment_confirmation'].includes(run.status) && run.items.some((item) => item.status === 'pending')) {
    run = await updateRun(run.id, (current) => ({ ...current, status: 'running' }), options);
  }
  if (isTerminalRun(run) || ['awaiting_confirmation', 'scheduled'].includes(run.status)) {
    return { run, enqueued: false, alreadyRunning: false };
  }
  const runKey = activeRunKey(runId, options);
  if (activeBugAnalysisRuns.has(runKey)) {
    return { run, enqueued: false, alreadyRunning: true };
  }
  const promise = Promise.resolve().then(() => runBugAnalysisLoop(runId, options)).catch((error) => {
    console.error('[jira-bug-analysis] background run failed:', runId, error && error.message ? error.message : error);
  });
  activeBugAnalysisRuns.set(runKey, promise);
  if (options.awaitBackground === true) {
    await promise;
  }
  return { run, enqueued: true, alreadyRunning: false };
}

async function resetAutoRetryableItems(runId, options = {}) {
  return updateRun(runId, (run) => ({
    ...run,
    items: run.items.map((item) => {
      if (!isAutoRetryableRecoveryItem(item, run)) {
        return item;
      }
      return {
        ...item,
        status: 'pending',
        recovery: null,
        analysisStartedAt: null,
        updatedAt: nowIso(options.now || new Date())
      };
    })
  }), options);
}

async function resumeBugAnalysisRun(runId, input = {}, options = {}) {
  let run = await getBugAnalysisRun(runId, options);
  if (run.items.some((item) => isAutoRetryableRecoveryItem(item, run))) {
    run = await resetAutoRetryableItems(run.id, options);
  }
  if (run.status === 'awaiting_confirmation') {
    run = await confirmBugAnalysisRun(run.id, input, options);
  } else if (run.status === 'scheduled' && isDueAt(run.scheduleAt, options.now || new Date())) {
    const activated = await activateDueBugAnalysisRuns(options);
    run = activated.find((candidate) => candidate.id === run.id) || await getBugAnalysisRun(run.id, options);
  } else if (['partial_failed', 'awaiting_comment_confirmation'].includes(run.status) && run.items.some((item) => item.status === 'pending')) {
    run = await updateRun(run.id, (current) => ({ ...current, status: 'running' }), options);
  }
  run = await recoverStaleAnalyzingRun(run.id, options);
  const enqueue = await enqueueBugAnalysisRun(run.id, options);
  return { run: enqueue.run, enqueued: enqueue.enqueued, alreadyRunning: enqueue.alreadyRunning };
}

function isReusableBugAnalysisRun(run = {}) {
  if (isTerminalRun(run) || run.status === 'awaiting_comment_confirmation') {
    return false;
  }
  return (run.items || []).some((item) => item.status === 'pending' || item.status === 'analyzing' || isAutoRetryableRecoveryItem(item, run));
}

async function findReusableBugAnalysisRun(input = {}, options = {}) {
  const issueKeys = normalizeIssueKeys(Array.isArray(input.issueKeys) ? input.issueKeys : []);
  if (issueKeys.length === 0) {
    return null;
  }
  const signature = issueKeys.join('|');
  const index = await readIndex(options.baizeRoot);
  const candidates = index.runs
    .filter((run) => isReusableBugAnalysisRun(run) && runIssueKeySignature(run) === signature)
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
  return candidates.find((run) => input.conversationId && run.conversationId === input.conversationId)
    || candidates.find((run) => input.clientId && run.clientId === input.clientId)
    || candidates[0]
    || null;
}

async function createOrResumeBugAnalysisRun(input = {}, options = {}) {
  const reusable = await findReusableBugAnalysisRun(input, options);
  if (reusable) {
    const resumed = await resumeBugAnalysisRun(reusable.id, input, options);
    return { ...resumed, reused: true };
  }
  const created = await createBugAnalysisRun(input, options);
  const resumed = await resumeBugAnalysisRun(created.run.id, input, options);
  return { job: created.job, ...resumed, reused: false };
}

async function recoverInterruptedBugAnalysisRuns(options = {}) {
  const activated = await activateDueBugAnalysisRuns(options);
  const index = await readIndex(options.baizeRoot);
  const resumable = index.runs.filter((run) => {
    if (isTerminalRun(run) || ['awaiting_confirmation', 'scheduled'].includes(run.status)) {
      return false;
    }
    return run.items.some((item) => item.status === 'pending' || item.status === 'analyzing' || isAutoRetryableRecoveryItem(item, run));
  });
  const enqueued = [];
  for (const run of [...activated, ...resumable]) {
    const result = await resumeBugAnalysisRun(run.id, {}, options);
    if (result.enqueued || result.alreadyRunning) {
      enqueued.push(result.run);
    }
  }
  return { activated, enqueued };
}

async function processDueBugAnalysisRuns(options = {}) {
  return recoverInterruptedBugAnalysisRuns(options);
}

async function confirmBugAnalysisItemComment(runId, itemId, input = {}, options = {}) {
  const run = await getBugAnalysisRun(runId, options);
  const item = run.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw jiraError('Bug 分析 Item 不存在。', 'NOT_FOUND', 404);
  }
  if (item.status !== 'awaiting_comment_confirmation') {
    throw jiraError('Bug 分析 Item 当前没有可确认评论。', 'INVALID_ITEM_STATUS', 409);
  }
  const config = await getJiraConfig(options);
  const body = readString(input.commentBody) || item.commentDraft;
  const comment = await addJiraComment(config, item.issueKey, body, { fetchImpl: options.fetchImpl });
  return updateRun(runId, (current) => ({
    ...current,
    items: current.items.map((candidate) => candidate.id === itemId
      ? {
          ...candidate,
          status: 'completed',
          jiraComment: { id: comment.id || null, self: comment.self || null },
          updatedAt: nowIso(options.now || new Date())
        }
      : candidate)
  }), options);
}

async function applyBugAnalysisRecovery(runId, itemId, input = {}, options = {}) {
  const actionId = readString(input.actionId);
  if (!RECOVERY_ACTIONS.includes(actionId)) {
    throw jiraError('Bug 分析恢复动作不在服务器白名单内。', 'INVALID_RECOVERY_ACTION', 400);
  }
  if (actionId === 'retry_analysis') {
    await updateRun(runId, (run) => ({
      ...run,
      status: 'running',
      items: run.items.map((item) => item.id === itemId
        ? { ...item, status: 'pending', recovery: null, error: null, updatedAt: nowIso(options.now || new Date()) }
        : item)
    }), options);
    return resumeBugAnalysisRun(runId, input, options).then((result) => result.run);
  }
  return updateRun(runId, (run) => {
    if (actionId === 'cancel_run') {
      return { ...run, status: 'cancelled', finishedAt: nowIso(options.now || new Date()) };
    }
    return {
      ...run,
      items: run.items.map((item) => item.id === itemId
        ? { ...item, status: 'skipped', recovery: null, error: null, updatedAt: nowIso(options.now || new Date()) }
        : item)
    };
  }, options);
}

module.exports = {
  BUG_ANALYSIS_MARKER,
  BUG_ANALYSIS_TIMEOUT_MS,
  BUG_ANALYSIS_ITEM_TIMEOUT_MS,
  BUG_ANALYSIS_MAX_ATTEMPTS,
  buildBugJql,
  createBugAnalysisRun,
  createOrResumeBugAnalysisRun,
  getBugAnalysisRun,
  confirmBugAnalysisRun,
  activateDueBugAnalysisRuns,
  processDueBugAnalysisRuns,
  processNextBugAnalysisItem,
  analyzeBugAnalysisItem,
  enqueueBugAnalysisRun,
  resumeBugAnalysisRun,
  recoverInterruptedBugAnalysisRuns,
  confirmBugAnalysisItemComment,
  applyBugAnalysisRecovery
};
