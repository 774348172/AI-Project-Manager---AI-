const childProcess = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const paths = require('../config/paths');
const { getUnityBuildConfig } = require('./config-service');
const { readJsonIfExists, writeJson } = require('../lib/file-store');
const { sendWeComTextMessage } = require('./wecom-client-service');
const { sendWeComAiBotMarkdown } = require('./wecom-aibot-service');

const DEFAULT_STATE = {
  enabled: false,
  running: false,
  lastRun: null,
  lastResult: null,
  updatedAt: null
};
const MAX_LOG_LENGTH = 6000;

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function getStatePath(baizeRoot = paths.BAIZE_ROOT) {
  return path.join(baizeRoot, 'runtime', 'unity-build-scheduler', 'state.json');
}

function getRunLogPath(baizeRoot = paths.BAIZE_ROOT) {
  return path.join(baizeRoot, 'runtime', 'unity-build-scheduler', 'runs.jsonl');
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {})
  };
}

async function readSchedulerState(options = {}) {
  return normalizeState(await readJsonIfExists(getStatePath(options.baizeRoot), DEFAULT_STATE));
}

async function writeSchedulerState(state, options = {}) {
  const next = normalizeState({ ...state, updatedAt: nowIso(options.now || new Date()) });
  await writeJson(getStatePath(options.baizeRoot), next, options.baizeRoot || paths.BAIZE_ROOT);
  return next;
}

async function appendRunLog(entry, options = {}) {
  const baizeRoot = options.baizeRoot || paths.BAIZE_ROOT;
  const logPath = getRunLogPath(baizeRoot);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function setUnityBuildSchedulerEnabled(enabled, input = {}, options = {}) {
  const state = await readSchedulerState(options);
  return writeSchedulerState({
    ...state,
    enabled: enabled === true,
    changedBy: input.clientId || input.userId || 'unknown'
  }, options);
}

function buildSvnArgs(config, svnArgs) {
  const args = [...svnArgs, config.workspacePath];
  if (config.svn.username) {
    args.push('--username', config.svn.username);
  }
  if (config.svn.password) {
    args.push('--password', config.svn.password);
  }
  args.push('--non-interactive');
  return args;
}

function redactSensitiveText(text, secrets = []) {
  let value = String(text || '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim() !== '') {
      value = value.split(secret).join('[已脱敏]');
    }
  }
  return value.replace(/(--password\s+)(\S+)/gi, '$1[已脱敏]');
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || 300000;
  const secrets = options.secrets || [];
  return new Promise((resolve) => {
    options.execFileImpl(command, args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: error && typeof error.code !== 'undefined' ? error.code : 0,
        signal: error && error.signal ? error.signal : null,
        stdout: redactSensitiveText(stdout, secrets),
        stderr: redactSensitiveText(stderr, secrets),
        error: error && error.message ? redactSensitiveText(error.message, secrets) : null
      });
    });
  });
}

function truncateLog(text) {
  const value = String(text || '').trim();
  if (value.length <= MAX_LOG_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LOG_LENGTH)}\n...日志已截断...`;
}

function summarizeCommandResult(name, result) {
  const parts = [`${name}: ${result.ok ? '成功' : '失败'}`];
  if (result.code) {
    parts.push(`退出码：${result.code}`);
  }
  if (result.error) {
    parts.push(`错误：${result.error}`);
  }
  const output = truncateLog([result.stdout, result.stderr].filter(Boolean).join('\n'));
  if (output) {
    parts.push(output);
  }
  return parts.join('\n');
}

function redactLocalPaths(text) {
  return String(text || '').replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[本机路径]');
}

function extractErrorLines(text) {
  const patterns = [
    /\berror\s+CS\d{4}\b/i,
    /^error\b/i,
    /^Exception\b/i,
    /\bUnhandled exception\b/i,
    /BuildFailedException/i,
    /Compilation failed/i,
    /Build completed with a result of ['"]?Failed['"]?/i,
    /Error building Player/i,
    /CommandInvokationFailure/i,
    /Scripts have compiler errors/i,
    /executeMethod class .*could not be found/i,
    /Argument was -executeMethod/i,
    /Aborting batchmode due to failure/i,
    /编译.*(失败|错误)/,
    /(失败|错误).*编译/
  ];
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/\): warning CS\d{4}/i.test(line) && patterns.some((pattern) => pattern.test(line)))
    .join('\n');
}

async function writeSvnInfoFile(config, commandOptions) {
  const info = await runCommand('svn', buildSvnArgs(config, ['info']), commandOptions);
  if (info.ok) {
    await fs.mkdir(config.workspacePath, { recursive: true });
    await fs.writeFile(path.join(config.workspacePath, 'SvnInfo.txt'), info.stdout, 'utf8');
  }
  return info;
}

async function runSvnUpdate(config, options = {}) {
  if (!config.svn.enabled) {
    return { ok: true, skipped: true, stdout: 'SVN 更新已关闭。', stderr: '' };
  }
  const commandOptions = {
    execFileImpl: options.execFileImpl || childProcess.execFile,
    cwd: config.workspacePath,
    timeoutMs: options.svnTimeoutMs || 10 * 60 * 1000,
    secrets: [config.svn.username, config.svn.password]
  };
  const cleanup = await runCommand('svn', buildSvnArgs(config, ['cleanup']), commandOptions);
  if (!cleanup.ok) {
    return cleanup;
  }
  const update = await runCommand('svn', buildSvnArgs(config, config.svn.updateArgs), commandOptions);
  if (!update.ok) {
    return {
      ...update,
      stdout: [cleanup.stdout, update.stdout].filter(Boolean).join('\n'),
      stderr: [cleanup.stderr, update.stderr].filter(Boolean).join('\n')
    };
  }
  const info = await writeSvnInfoFile(config, commandOptions);
  return {
    ...info,
    stdout: [cleanup.stdout, update.stdout, info.stdout].filter(Boolean).join('\n'),
    stderr: [cleanup.stderr, update.stderr, info.stderr].filter(Boolean).join('\n')
  };
}

async function runUnityMcpBuild(config, options = {}) {
  if (!config.unityMcp.command) {
    throw validationError('Unity MCP 编译命令未配置。');
  }
  return runCommand(config.unityMcp.command, config.unityMcp.args, {
    execFileImpl: options.execFileImpl || childProcess.execFile,
    cwd: config.workspacePath,
    timeoutMs: config.unityMcp.timeoutMs
  });
}

async function sendWeComWebhook(webhookUrl, content, options = {}) {
  const response = await (options.fetchImpl || fetch)(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } })
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    payload = { errmsg: text };
  }
  if (!response.ok || (Object.prototype.hasOwnProperty.call(payload, 'errcode') && payload.errcode !== 0)) {
    throw validationError(`企业微信机器人通知失败：${payload.errmsg || response.status}`);
  }
  return payload;
}

function buildFailureMessage({ buildResult }) {
  const errorOutput = extractErrorLines([buildResult.stderr, buildResult.error, buildResult.stdout].filter(Boolean).join('\n'));
  const message = errorOutput || 'Unity 编译失败，但未输出明确的 error 行。请查看服务器 Unity Editor.log。';
  return truncateLog(redactLocalPaths(message));
}

async function notifyBuildFailure(config, content, options = {}) {
  if (!config.notify.enabled) {
    return { sent: false, reason: 'notify_disabled' };
  }
  if (config.notify.webhookUrl) {
    await sendWeComWebhook(config.notify.webhookUrl, content, options);
    return { sent: true, channel: 'wecom_webhook' };
  }
  if (config.notify.toUser) {
    await sendWeComTextMessage({ toUser: config.notify.toUser, content }, options);
    return { sent: true, channel: 'wecom_app' };
  }
  if (config.notify.aiBotChatId) {
    await sendWeComAiBotMarkdown({ chatId: config.notify.aiBotChatId, content }, options);
    return { sent: true, channel: 'wecom_aibot' };
  }
  return { sent: false, reason: 'notify_receiver_missing' };
}

async function executeUnityBuildOnce(options = {}) {
  const config = options.config || await getUnityBuildConfig(options);
  if (!config.workspacePath) {
    throw validationError('Unity 工程工作区未配置。');
  }
  const startedAt = nowIso(options.now || new Date());
  await writeSchedulerState({ ...(await readSchedulerState(options)), running: true, lastRun: { startedAt } }, options);

  let nextState;
  try {
    const svnResult = await runSvnUpdate(config, options);
    const buildResult = svnResult.ok ? await runUnityMcpBuild(config, options) : {
      ok: false,
      code: svnResult.code,
      stdout: '',
      stderr: 'SVN 更新失败，已跳过 Unity 编译。',
      error: svnResult.error
    };
    const status = svnResult.ok && buildResult.ok ? 'success' : 'failed';
    let notification = { sent: false };
    if (status === 'failed') {
      try {
        notification = await notifyBuildFailure(config, buildFailureMessage({ startedAt, svnResult, buildResult }), options);
      } catch (error) {
        notification = {
          sent: false,
          status: 'failed',
          error: error.publicMessage || error.message || '企业微信机器人通知失败。'
        };
      }
    }
    const finishedAt = nowIso(options.now || new Date());
    const lastResult = {
      status,
      svn: { ok: svnResult.ok, skipped: svnResult.skipped === true, code: svnResult.code || 0, summary: summarizeCommandResult('SVN 更新', svnResult) },
      unity: { ok: buildResult.ok, code: buildResult.code || 0, summary: summarizeCommandResult('Unity MCP 编译', buildResult) },
      notification
    };
    nextState = await writeSchedulerState({
      ...(await readSchedulerState(options)),
      running: false,
      lastRun: { startedAt, finishedAt },
      lastResult
    }, options);
    await appendRunLog({ startedAt, finishedAt, ...lastResult }, options);
    return nextState;
  } catch (error) {
    const finishedAt = nowIso(options.now || new Date());
    const lastResult = {
      status: 'failed',
      error: error.publicMessage || error.message || 'Unity 定时编译失败。'
    };
    nextState = await writeSchedulerState({
      ...(await readSchedulerState(options)),
      running: false,
      lastRun: { startedAt, finishedAt },
      lastResult
    }, options);
    await appendRunLog({ startedAt, finishedAt, ...lastResult }, options);
    throw error;
  }
}

async function tickUnityBuildScheduler(options = {}) {
  const config = options.config || await getUnityBuildConfig(options);
  const state = await readSchedulerState(options);
  if (!config.enabled || !state.enabled) {
    return { skipped: true, reason: 'disabled', state };
  }
  if (state.running) {
    return { skipped: true, reason: 'running', state };
  }
  const now = options.now || new Date();
  const lastStartedAt = state.lastRun && state.lastRun.startedAt ? Date.parse(state.lastRun.startedAt) : 0;
  if (lastStartedAt && now.getTime() - lastStartedAt < config.intervalMinutes * 60 * 1000) {
    return { skipped: true, reason: 'not_due', state };
  }
  return { skipped: false, state: await executeUnityBuildOnce({ ...options, config }) };
}

function createUnityBuildScheduler(options = {}) {
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) {
      return { skipped: true, reason: 'running' };
    }
    ticking = true;
    try {
      return await tickUnityBuildScheduler(options);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) {
      return timer;
    }
    const intervalMs = options.tickMs || 60 * 1000;
    timer = setInterval(() => {
      tick().catch((error) => {
        console.error('[unity-build] scheduler tick failed:', error && error.message ? error.message : error);
      });
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}

module.exports = {
  readSchedulerState,
  setUnityBuildSchedulerEnabled,
  executeUnityBuildOnce,
  tickUnityBuildScheduler,
  createUnityBuildScheduler,
  runSvnUpdate,
  runUnityMcpBuild,
  notifyBuildFailure,
  buildFailureMessage
};
