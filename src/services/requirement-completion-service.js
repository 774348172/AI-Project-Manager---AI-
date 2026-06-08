const crypto = require('crypto');
const path = require('path');
const childProcess = require('child_process');
const paths = require('../config/paths');
const { readJsonIfExists, writeJson } = require('../lib/file-store');
const { getClaudeCodeConfig } = require('./config-service');
const { runClaudeCodeTask } = require('./claude-code-service');

const REQUIREMENT_COMPLETION_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS = 60 * 60 * 1000;
const REQUIREMENT_COMPLETION_SVN_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'];
const activeRequirementCompletionRuns = new Map();

function requirementError(message, code = 'REQUIREMENT_COMPLETION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function getStorePaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'runtime', 'requirement-completion');
  return {
    root,
    indexFile: path.join(root, 'index.json')
  };
}

async function readIndex(baizeRoot) {
  return readJsonIfExists(getStorePaths(baizeRoot).indexFile, { runs: [] });
}

async function writeIndex(index, baizeRoot) {
  const store = getStorePaths(baizeRoot);
  await writeJson(store.indexFile, { runs: Array.isArray(index.runs) ? index.runs.slice(0, 200) : [] }, store.root);
}

function completionScope(options = {}) {
  return path.resolve(options.baizeRoot || paths.BAIZE_ROOT);
}

function activeRunKey(runId, options = {}) {
  return `${completionScope(options)}:${runId}`;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isNaN(timestamp) ? null : timestamp;
}

function buildDeadline(now = new Date(), timeoutMs = REQUIREMENT_COMPLETION_TIMEOUT_MS) {
  return nowIso(new Date(now.getTime() + timeoutMs));
}

function getRunTimeoutMs(run = {}) {
  return Number.isInteger(run.timeoutMs) && run.timeoutMs > 0 ? run.timeoutMs : REQUIREMENT_COMPLETION_TIMEOUT_MS;
}

function getStageTimeoutMs(run = {}) {
  return Number.isInteger(run.stageTimeoutMs) && run.stageTimeoutMs > 0 ? run.stageTimeoutMs : REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS;
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

function isTerminalRun(run = {}) {
  return TERMINAL_RUN_STATUSES.includes(run.status);
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
  const timeoutMs = options.timeoutMs || REQUIREMENT_COMPLETION_SVN_UPDATE_TIMEOUT_MS;
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

async function runRequirementCompletionSvnMaintenance(workspacePath, svnConfig = {}) {
  if (!workspacePath) {
    return '未配置工程目录，无法执行 SVN 维护；Claude Code 只能基于默认工作区判断。';
  }
  const cleanup = await runSvn(['cleanup', workspacePath], { cwd: workspacePath, timeoutMs: REQUIREMENT_COMPLETION_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  if (!cleanup.ok) {
    return summarizeSvnStep('svn cleanup', cleanup);
  }

  const preResolve = await runSvn(['resolve', '--accept', 'theirs-full', '-R', workspacePath], { cwd: workspacePath, timeoutMs: REQUIREMENT_COMPLETION_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  const update = await runSvn(['update', '--accept', 'theirs-full', workspacePath], { cwd: workspacePath, timeoutMs: REQUIREMENT_COMPLETION_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  const postResolve = await runSvn(['resolve', '--accept', 'theirs-full', '-R', workspacePath], { cwd: workspacePath, timeoutMs: REQUIREMENT_COMPLETION_SVN_UPDATE_TIMEOUT_MS, svn: svnConfig });
  const status = await runSvn(['status', workspacePath], { cwd: workspacePath, timeoutMs: 2 * 60 * 1000, svn: svnConfig });
  return [
    summarizeSvnStep('svn cleanup', cleanup),
    summarizeSvnStep('svn resolve --accept theirs-full -R', preResolve),
    summarizeSvnStep('svn update --accept theirs-full', update),
    summarizeSvnStep('svn resolve --accept theirs-full -R', postResolve),
    summarizeSvnStep('svn status', status)
  ].join('\n\n');
}

function buildRequirementContext(run = {}, svnMaintenance = '') {
  return [
    `Run ID：${run.id}`,
    `需求标题：${run.title || '未命名需求'}`,
    `需求来源：${run.sourceType || 'manual'}`,
    run.issueKey ? `关联 Jira：${run.issueKey}` : '关联 Jira：无',
    '',
    '需求内容：',
    run.requirementText || '',
    '',
    '附件：',
    Array.isArray(run.attachments) && run.attachments.length > 0 ? JSON.stringify(run.attachments, null, 2) : '无',
    '',
    'SVN 维护结果：',
    svnMaintenance || '未提供。'
  ].join('\n');
}

function validatePlan(plan) {
  const text = String(plan || '');
  const hasEvidenceWord = /(工程依据|相关文件|模块|配置|资源|路径|验证)/i.test(text);
  const hasPath = /([A-Za-z]:[\\/][^\s，。；]+|\b(?:Assets|src|client|server|baize|tests|config)[\\/][^\s，。；]+|\b[^\s，。；]+\.(?:js|cjs|ts|tsx|cs|json|yaml|yml|prefab|lua|asset|bytes|md)\b)/i.test(text);
  const hasPlan = /(实施步骤|执行计划|修改|验证方案|风险)/i.test(text);
  return hasEvidenceWord && hasPath && hasPlan;
}

function validateExecutionReport(report) {
  const text = String(report || '');
  const hasResult = /(修改文件|验证结果|完成报告|工程依据|未完成风险)/i.test(text);
  const hasPath = /([A-Za-z]:[\\/][^\s，。；]+|\b(?:Assets|src|client|server|baize|tests|config)[\\/][^\s，。；]+|\b[^\s，。；]+\.(?:js|cjs|ts|tsx|cs|json|yaml|yml|prefab|lua|asset|bytes|md)\b)/i.test(text);
  return hasResult && hasPath;
}

function withRequirementCompletionTimeout(claudeCodeConfig = {}, timeoutMs = REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS) {
  const workspacePath = claudeCodeConfig.requirementCompletionWorkspacePath || claudeCodeConfig.bugAnalysisWorkspacePath || claudeCodeConfig.workspacePath;
  return {
    ...claudeCodeConfig,
    timeoutMs,
    workspacePath,
    requirementCompletionWorkspacePath: workspacePath
  };
}

function sanitizeRun(run) {
  return run || null;
}

async function updateRun(runId, updater, options = {}) {
  const index = await readIndex(options.baizeRoot);
  const runIndex = index.runs.findIndex((item) => item.id === runId);
  if (runIndex === -1) {
    throw requirementError('需求完成批次不存在。', 'NOT_FOUND', 404);
  }
  const now = options.now || new Date();
  const updated = updater(index.runs[runIndex]);
  index.runs[runIndex] = { ...updated, updatedAt: nowIso(now) };
  await writeIndex(index, options.baizeRoot);
  return sanitizeRun(index.runs[runIndex]);
}

async function createRequirementCompletionRun(input = {}, options = {}) {
  const requirementText = readString(input.requirementText) || readString(input.text);
  if (!requirementText) {
    throw requirementError('需求内容不能为空。', 'VALIDATION_ERROR', 400);
  }
  const now = options.now || new Date();
  const run = {
    id: `requirement-run-${crypto.randomUUID()}`,
    kind: 'requirement_completion_run',
    status: 'awaiting_plan',
    title: readString(input.title) || requirementText.slice(0, 60),
    requirementText,
    sourceType: readString(input.sourceType) || (readString(input.issueKey) ? 'jira_issue' : 'manual'),
    issueKey: readString(input.issueKey),
    clientId: readString(input.clientId),
    userId: readString(input.userId),
    conversationId: readString(input.conversationId),
    attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 20) : [],
    timeoutMs: REQUIREMENT_COMPLETION_TIMEOUT_MS,
    stageTimeoutMs: REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
    plan: null,
    executionResult: null,
    error: null,
    recovery: null,
    createdAt: nowIso(now),
    updatedAt: nowIso(now)
  };
  const index = await readIndex(options.baizeRoot);
  index.runs = [run, ...index.runs];
  await writeIndex(index, options.baizeRoot);
  return { run: sanitizeRun(run) };
}

async function getRequirementCompletionRun(runId, options = {}) {
  const index = await readIndex(options.baizeRoot);
  const run = index.runs.find((item) => item.id === runId);
  if (!run) {
    throw requirementError('需求完成批次不存在。', 'NOT_FOUND', 404);
  }
  return sanitizeRun(run);
}

async function generateRequirementCompletionPlan(runId, input = {}, options = {}) {
  const now = options.now || new Date();
  let targetRun = await updateRun(runId, (run) => {
    if (!['awaiting_plan', 'planning', 'plan_failed'].includes(run.status)) {
      throw requirementError('需求完成批次当前状态不能生成计划。', 'INVALID_RUN_STATUS', 409);
    }
    return {
      ...run,
      status: 'planning',
      startedAt: run.startedAt || nowIso(now),
      deadlineAt: run.deadlineAt || buildDeadline(now, getRunTimeoutMs(run)),
      plan: run.status === 'awaiting_plan' ? null : run.plan,
      error: null,
      recovery: null,
      planningStartedAt: nowIso(now)
    };
  }, options);

  try {
    const claudeCodeConfig = await getClaudeCodeConfig(options);
    const workspacePath = claudeCodeConfig.requirementCompletionWorkspacePath || claudeCodeConfig.bugAnalysisWorkspacePath || claudeCodeConfig.workspacePath;
    const svnMaintenance = await runRequirementCompletionSvnMaintenance(workspacePath, claudeCodeConfig.svn);
    const timeoutMs = Math.max(1000, Math.min(getRemainingRunMs(targetRun, new Date()), getStageTimeoutMs(targetRun), claudeCodeConfig.bugAnalysisTimeoutMs || REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS));
    const planText = await runClaudeCodeTask({
      message: { text: [buildRequirementContext(targetRun, svnMaintenance), '', readString(input.extraInstruction) || ''].filter(Boolean).join('\n') },
      memoryQuery: [targetRun.title, targetRun.requirementText, targetRun.issueKey].filter(Boolean).join('\n'),
      permissionMode: 'requirement_completion_plan',
      claudeCodeConfig: withRequirementCompletionTimeout(claudeCodeConfig, timeoutMs),
      runner: options.claudeCodeRunner
    });
    if (!validatePlan(planText)) {
      throw requirementError('需求完成计划缺少工程依据、预计修改文件或验证方案。', 'MISSING_ENGINEERING_PLAN_EVIDENCE', 422);
    }
    return updateRun(runId, (run) => ({
      ...run,
      status: 'awaiting_execution_confirmation',
      plan: {
        text: planText,
        svnMaintenance,
        generatedAt: nowIso(options.now || new Date()),
        generatedBy: 'claude_code'
      },
      planningStartedAt: null,
      error: null,
      recovery: null
    }), options);
  } catch (error) {
    return updateRun(runId, (run) => ({
      ...run,
      status: 'plan_failed',
      planningStartedAt: null,
      error: error.publicMessage || error.message || '需求完成计划生成失败。',
      recovery: buildDefaultRecovery(error, 'plan')
    }), options);
  }
}

function buildDefaultRecovery(error, stage) {
  return {
    status: 'available',
    analyzedBy: 'server',
    analyzedAt: nowIso(),
    stage,
    summary: stage === 'execute' ? '需求执行失败，可以重试执行或取消。' : '需求计划生成失败，可以重试计划或取消。',
    reason: error.publicMessage || error.message || String(error),
    actions: stage === 'execute'
      ? [
          { id: 'retry_execution', label: '重试执行', requiresConfirmation: true },
          { id: 'cancel_run', label: '取消需求完成', requiresConfirmation: true }
        ]
      : [
          { id: 'retry_plan', label: '重试生成计划', requiresConfirmation: false },
          { id: 'cancel_run', label: '取消需求完成', requiresConfirmation: true }
        ]
  };
}

async function confirmRequirementCompletionPlan(runId, input = {}, options = {}) {
  return updateRun(runId, (run) => {
    if (run.status !== 'awaiting_execution_confirmation' || !run.plan || !run.plan.text) {
      throw requirementError('需求完成批次当前没有可确认的执行计划。', 'INVALID_RUN_STATUS', 409);
    }
    return {
      ...run,
      status: 'queued_for_execution',
      confirmedBy: readString(input.clientId) || readString(input.userId),
      confirmedAt: nowIso(options.now || new Date()),
      error: null,
      recovery: null
    };
  }, options);
}

async function executeRequirementCompletionRun(runId, input = {}, options = {}) {
  const now = options.now || new Date();
  let targetRun = await updateRun(runId, (run) => {
    if (!['queued_for_execution', 'execution_failed'].includes(run.status)) {
      throw requirementError('需求完成批次当前状态不能执行。', 'INVALID_RUN_STATUS', 409);
    }
    if (!run.plan || !run.plan.text) {
      throw requirementError('需求完成批次缺少已确认计划。', 'MISSING_PLAN', 409);
    }
    if (isRunDeadlineExceeded(run, now)) {
      return { ...run, status: 'timed_out', finishedAt: nowIso(now) };
    }
    return {
      ...run,
      status: 'executing',
      executionStartedAt: nowIso(now),
      error: null,
      recovery: null
    };
  }, options);
  if (targetRun.status === 'timed_out') {
    return targetRun;
  }

  try {
    const claudeCodeConfig = await getClaudeCodeConfig(options);
    const workspacePath = claudeCodeConfig.requirementCompletionWorkspacePath || claudeCodeConfig.bugAnalysisWorkspacePath || claudeCodeConfig.workspacePath;
    const svnMaintenance = await runRequirementCompletionSvnMaintenance(workspacePath, claudeCodeConfig.svn);
    const timeoutMs = Math.max(1000, Math.min(getRemainingRunMs(targetRun, new Date()), getStageTimeoutMs(targetRun), claudeCodeConfig.bugAnalysisTimeoutMs || REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS));
    const report = await runClaudeCodeTask({
      message: { text: buildRequirementContext(targetRun, svnMaintenance) },
      memoryQuery: [targetRun.title, targetRun.requirementText, targetRun.issueKey, targetRun.plan && targetRun.plan.text].filter(Boolean).join('\n'),
      permissionMode: 'requirement_completion_execution',
      confirmedPlan: targetRun.plan.text,
      claudeCodeConfig: withRequirementCompletionTimeout(claudeCodeConfig, timeoutMs),
      runner: options.claudeCodeRunner
    });
    if (!validateExecutionReport(report)) {
      throw requirementError('需求完成报告缺少修改文件、工程依据或验证结果。', 'MISSING_EXECUTION_REPORT_EVIDENCE', 422);
    }
    return updateRun(runId, (run) => ({
      ...run,
      status: 'completed',
      executionResult: {
        reply: report,
        svnMaintenance,
        completedAt: nowIso(options.now || new Date()),
        executedBy: 'claude_code'
      },
      executionStartedAt: null,
      finishedAt: nowIso(options.now || new Date()),
      error: null,
      recovery: null
    }), options);
  } catch (error) {
    return updateRun(runId, (run) => ({
      ...run,
      status: 'execution_failed',
      executionStartedAt: null,
      error: error.publicMessage || error.message || '需求完成执行失败。',
      recovery: buildDefaultRecovery(error, 'execute')
    }), options);
  }
}

async function runRequirementCompletionLoop(runId, options = {}) {
  try {
    while (true) {
      const run = await getRequirementCompletionRun(runId, options);
      if (isTerminalRun(run) || ['awaiting_plan', 'planning', 'plan_failed', 'awaiting_execution_confirmation'].includes(run.status)) {
        return run;
      }
      if (isRunDeadlineExceeded(run, options.now || new Date())) {
        return updateRun(runId, (current) => ({ ...current, status: 'timed_out', finishedAt: nowIso(options.now || new Date()) }), options);
      }
      if (run.status === 'queued_for_execution' || run.status === 'execution_failed') {
        await executeRequirementCompletionRun(runId, {}, options);
        continue;
      }
      return run;
    }
  } finally {
    activeRequirementCompletionRuns.delete(activeRunKey(runId, options));
  }
}

async function enqueueRequirementCompletionRun(runId, options = {}) {
  const run = await getRequirementCompletionRun(runId, options);
  if (isTerminalRun(run) || !['queued_for_execution', 'execution_failed'].includes(run.status)) {
    return { run, enqueued: false, alreadyRunning: false };
  }
  const runKey = activeRunKey(runId, options);
  if (activeRequirementCompletionRuns.has(runKey)) {
    return { run, enqueued: false, alreadyRunning: true };
  }
  const promise = Promise.resolve().then(() => runRequirementCompletionLoop(runId, options)).catch((error) => {
    console.error('[requirement-completion] background run failed:', runId, error && error.message ? error.message : error);
  });
  activeRequirementCompletionRuns.set(runKey, promise);
  if (options.awaitBackground === true) {
    await promise;
  }
  return { run, enqueued: true, alreadyRunning: false };
}

async function confirmAndEnqueueRequirementCompletionRun(runId, input = {}, options = {}) {
  const run = await confirmRequirementCompletionPlan(runId, input, options);
  const enqueue = await enqueueRequirementCompletionRun(run.id, options);
  return { run: enqueue.run, enqueued: enqueue.enqueued, alreadyRunning: enqueue.alreadyRunning };
}

async function applyRequirementCompletionRecovery(runId, input = {}, options = {}) {
  const actionId = readString(input.actionId);
  if (!['retry_plan', 'retry_execution', 'cancel_run'].includes(actionId)) {
    throw requirementError('需求完成恢复动作不在服务器白名单内。', 'INVALID_RECOVERY_ACTION', 400);
  }
  if (actionId === 'cancel_run') {
    return updateRun(runId, (run) => ({ ...run, status: 'cancelled', finishedAt: nowIso(options.now || new Date()) }), options);
  }
  if (actionId === 'retry_plan') {
    await updateRun(runId, (run) => ({ ...run, status: 'awaiting_plan', error: null, recovery: null }), options);
    return generateRequirementCompletionPlan(runId, input, options);
  }
  await updateRun(runId, (run) => ({ ...run, status: 'queued_for_execution', error: null, recovery: null }), options);
  const enqueue = await enqueueRequirementCompletionRun(runId, options);
  return enqueue.run;
}

async function recoverInterruptedRequirementCompletionRuns(options = {}) {
  const index = await readIndex(options.baizeRoot);
  const resumable = index.runs.filter((run) => ['queued_for_execution', 'executing'].includes(run.status));
  const enqueued = [];
  for (const run of resumable) {
    if (run.status === 'executing') {
      await updateRun(run.id, (current) => ({
        ...current,
        status: 'execution_failed',
        executionStartedAt: null,
        error: '服务重启前需求执行未完成，请确认后重试。',
        recovery: buildDefaultRecovery(new Error('服务重启前需求执行未完成，请确认后重试。'), 'execute')
      }), options);
      continue;
    }
    const result = await enqueueRequirementCompletionRun(run.id, options);
    if (result.enqueued || result.alreadyRunning) {
      enqueued.push(result.run);
    }
  }
  return { enqueued };
}

async function createOrResumeRequirementCompletionRun(input = {}, options = {}) {
  const created = await createRequirementCompletionRun(input, options);
  const planned = await generateRequirementCompletionPlan(created.run.id, {}, options);
  return { run: planned, reused: false };
}

module.exports = {
  REQUIREMENT_COMPLETION_TIMEOUT_MS,
  REQUIREMENT_COMPLETION_STAGE_TIMEOUT_MS,
  createRequirementCompletionRun,
  createOrResumeRequirementCompletionRun,
  getRequirementCompletionRun,
  generateRequirementCompletionPlan,
  confirmRequirementCompletionPlan,
  confirmAndEnqueueRequirementCompletionRun,
  executeRequirementCompletionRun,
  enqueueRequirementCompletionRun,
  applyRequirementCompletionRecovery,
  recoverInterruptedRequirementCompletionRuns,
  runRequirementCompletionSvnMaintenance
};
