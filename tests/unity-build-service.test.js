const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const {
  readSchedulerState,
  setUnityBuildSchedulerEnabled,
  executeUnityBuildOnce,
  tickUnityBuildScheduler,
  buildFailureMessage
} = require('../src/services/unity-build-service');
const { getUnityBuildConfig, getPublicUnityBuildConfig } = require('../src/services/config-service');

function createExecFileMock(results) {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const result = results.shift() || { stdout: '', stderr: '' };
    if (result.error) {
      callback(result.error, result.stdout || '', result.stderr || '');
      return;
    }
    callback(null, result.stdout || '', result.stderr || '');
  };
  execFileImpl.calls = calls;
  return execFileImpl;
}

describe('Unity build scheduler service', () => {
  it('reads Unity build config and redacts secrets publicly', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'unity-build.yaml'), [
      'enabled: true',
      'intervalMinutes: 30',
      'runOnServerStart: true',
      'workspacePath: D:/unity/project',
      'svn:',
      '  enabled: true',
      '  username: svn-user',
      '  password: svn-password',
      'unityMcp:',
      '  command: unity-mcp',
      '  args:',
      '    - build',
      '  timeoutMs: 120000',
      'notify:',
      '  enabled: true',
      '  webhookUrl: https://wecom.example.test/webhook',
      '  toUser: zhangsan',
      '  aiBotChatId: chat-1'
    ].join('\n'), 'utf8');

    const config = await getUnityBuildConfig({ baizeRoot });
    const publicConfig = await getPublicUnityBuildConfig({ baizeRoot });

    expect(config).toMatchObject({
      enabled: true,
      intervalMinutes: 30,
      runOnServerStart: true,
      workspacePath: 'D:/unity/project',
      svn: { enabled: true, username: 'svn-user', password: 'svn-password' },
      unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
      notify: { enabled: true, webhookUrl: 'https://wecom.example.test/webhook', toUser: 'zhangsan', aiBotChatId: 'chat-1' }
    });
    expect(publicConfig).toEqual({
      enabled: true,
      intervalMinutes: 30,
      runOnServerStart: true,
      workspaceConfigured: true,
      svn: { enabled: true, credentialConfigured: true },
      unityMcp: { commandConfigured: true, timeoutMs: 120000 },
      notify: { enabled: true, webhookConfigured: true, appReceiverConfigured: true, aiBotReceiverConfigured: true }
    });
    expect(JSON.stringify(publicConfig)).not.toContain('svn-password');
    expect(JSON.stringify(publicConfig)).not.toContain('wecom.example.test');
  });

  it('uses BUG analysis workspace when Unity workspace is not configured', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'unity-build.yaml'), [
      'enabled: true',
      'workspacePath: ""',
      'unityMcp:',
      '  command: unity-mcp'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'bugAnalysisWorkspacePath: D:/unity/bug-workspace'
    ].join('\n'), 'utf8');

    const config = await getUnityBuildConfig({ baizeRoot });
    const publicConfig = await getPublicUnityBuildConfig({ baizeRoot });

    expect(config.workspacePath).toBe('D:/unity/bug-workspace');
    expect(publicConfig.workspaceConfigured).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toContain('D:/unity/bug-workspace');
  });

  it('persists client-enabled scheduler state', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(readSchedulerState({ baizeRoot })).resolves.toMatchObject({ enabled: false, running: false });

    const state = await setUnityBuildSchedulerEnabled(true, { clientId: 'desktop-1' }, { baizeRoot, now: new Date('2026-05-30T01:00:00.000Z') });

    expect(state).toMatchObject({ enabled: true, changedBy: 'desktop-1', updatedAt: '2026-05-30T01:00:00.000Z' });
    await expect(readSchedulerState({ baizeRoot })).resolves.toMatchObject({ enabled: true, changedBy: 'desktop-1' });
  });

  it('runs SVN update then Unity MCP build successfully', async () => {
    const { baizeRoot } = await createTestRoot();
    const execFileImpl = createExecFileMock([
      { stdout: 'Cleanup finished.' },
      { stdout: 'Updated to revision 1.' },
      { stdout: 'Last Changed Rev: 1' },
      { stdout: 'Build succeeded.' }
    ]);

    const state = await executeUnityBuildOnce({
      baizeRoot,
      now: new Date('2026-05-30T02:00:00.000Z'),
      execFileImpl,
      config: {
        workspacePath: 'D:/unity/project',
        svn: { enabled: true, updateArgs: ['update'], username: 'svn-user', password: 'svn-password' },
        unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
        notify: { enabled: true, webhookUrl: null, toUser: null, aiBotChatId: null }
      }
    });

    expect(execFileImpl.calls).toHaveLength(4);
    expect(execFileImpl.calls[0].command).toBe('svn');
    expect(execFileImpl.calls[0].args).toEqual(['cleanup', 'D:/unity/project', '--username', 'svn-user', '--password', 'svn-password', '--non-interactive']);
    expect(execFileImpl.calls[1].command).toBe('svn');
    expect(execFileImpl.calls[1].args).toEqual(['update', 'D:/unity/project', '--username', 'svn-user', '--password', 'svn-password', '--non-interactive']);
    expect(execFileImpl.calls[2].command).toBe('svn');
    expect(execFileImpl.calls[2].args).toEqual(['info', 'D:/unity/project', '--username', 'svn-user', '--password', 'svn-password', '--non-interactive']);
    expect(execFileImpl.calls[3].command).toBe('unity-mcp');
    expect(execFileImpl.calls[3].args).toEqual(['build']);
    expect(state.lastResult.status).toBe('success');

    const logContent = await fs.readFile(path.join(baizeRoot, 'runtime', 'unity-build-scheduler', 'runs.jsonl'), 'utf8');
    const logEntry = JSON.parse(logContent.trim());
    expect(logEntry).toMatchObject({
      startedAt: '2026-05-30T02:00:00.000Z',
      finishedAt: '2026-05-30T02:00:00.000Z',
      status: 'success',
      svn: { ok: true, skipped: false, code: 0 },
      unity: { ok: true, code: 0 },
      notification: { sent: false }
    });
  });

  it('redacts SVN credentials from failed command summaries', async () => {
    const { baizeRoot } = await createTestRoot();
    const execFileImpl = createExecFileMock([
      { stdout: 'Cleanup finished.' },
      {
        error: Object.assign(new Error('Command failed: svn update D:/unity/project --password svn-password'), { code: 1 }),
        stdout: 'svn-password stdout',
        stderr: 'svn-password stderr'
      }
    ]);

    const state = await executeUnityBuildOnce({
      baizeRoot,
      now: new Date('2026-05-30T02:30:00.000Z'),
      execFileImpl,
      config: {
        workspacePath: 'D:/unity/project',
        svn: { enabled: true, updateArgs: ['update'], username: 'svn-user', password: 'svn-password' },
        unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
        notify: { enabled: false, webhookUrl: null, toUser: null, aiBotChatId: null }
      }
    });

    expect(state.lastResult.status).toBe('failed');
    expect(JSON.stringify(state.lastResult)).not.toContain('svn-password');
    expect(state.lastResult.svn.summary).toContain('[已脱敏]');
  });

  it('sends WeCom robot notification when build fails', async () => {
    const { baizeRoot } = await createTestRoot();
    const execFileImpl = createExecFileMock([
      { stdout: 'Cleanup finished.' },
      { stdout: 'Updated.' },
      { stdout: 'Last Changed Rev: 1' },
      { error: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'compile error CS1002' }
    ]);
    let notificationRequest;
    const fetchImpl = async (url, options) => {
      notificationRequest = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0 }) };
    };

    const state = await executeUnityBuildOnce({
      baizeRoot,
      now: new Date('2026-05-30T03:00:00.000Z'),
      execFileImpl,
      fetchImpl,
      config: {
        workspacePath: 'D:/unity/project',
        svn: { enabled: true, updateArgs: ['update'], username: null, password: null },
        unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
        notify: { enabled: true, webhookUrl: 'https://wecom.example.test/webhook', toUser: null, aiBotChatId: null }
      }
    });

    expect(state.lastResult.status).toBe('failed');
    expect(state.lastResult.notification).toEqual({ sent: true, channel: 'wecom_webhook' });
    expect(notificationRequest.url).toBe('https://wecom.example.test/webhook');
    expect(JSON.parse(notificationRequest.options.body).text.content).toContain('compile error CS1002');
  });

  it('sends WeCom AI bot notification when build fails and chat id is configured', async () => {
    const { baizeRoot } = await createTestRoot();
    const execFileImpl = createExecFileMock([
      { stdout: 'Cleanup finished.' },
      { stdout: 'Updated.' },
      { stdout: 'Last Changed Rev: 1' },
      { error: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'compile error CS1002' }
    ]);
    const messages = [];
    const client = {
      sendMessage: async (chatId, body) => {
        messages.push({ chatId, body });
        return { errcode: 0 };
      }
    };
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'wecom.yaml'), [
      'aiBot:',
      '  enabled: true',
      '  botId: bot-id',
      '  secret: bot-secret'
    ].join('\n'), 'utf8');

    const state = await executeUnityBuildOnce({
      baizeRoot,
      now: new Date('2026-05-30T03:30:00.000Z'),
      execFileImpl,
      client,
      config: {
        workspacePath: 'D:/unity/project',
        svn: { enabled: true, updateArgs: ['update'], username: null, password: null },
        unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
        notify: { enabled: true, webhookUrl: null, toUser: null, aiBotChatId: 'chat-1' }
      }
    });

    expect(state.lastResult.status).toBe('failed');
    expect(state.lastResult.notification).toEqual({ sent: true, channel: 'wecom_aibot' });
    expect(messages).toEqual([
      {
        chatId: 'chat-1',
        body: { msgtype: 'markdown', markdown: { content: expect.stringContaining('compile error CS1002') } }
      }
    ]);
  });

  it('keeps build result and run log when failure notification fails', async () => {
    const { baizeRoot } = await createTestRoot();
    const execFileImpl = createExecFileMock([
      { stdout: 'Cleanup finished.' },
      { stdout: 'Updated.' },
      { stdout: 'Last Changed Rev: 1' },
      { error: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'compile error CS1002' }
    ]);
    const client = {
      sendMessage: async () => {
        throw new Error('WebSocket not connected, unable to send data');
      }
    };
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'wecom.yaml'), [
      'aiBot:',
      '  enabled: true',
      '  botId: bot-id',
      '  secret: bot-secret'
    ].join('\n'), 'utf8');

    const state = await executeUnityBuildOnce({
      baizeRoot,
      now: new Date('2026-05-30T03:45:00.000Z'),
      execFileImpl,
      client,
      config: {
        workspacePath: 'D:/unity/project',
        svn: { enabled: true, updateArgs: ['update'], username: null, password: null },
        unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
        notify: { enabled: true, webhookUrl: null, toUser: null, aiBotChatId: 'chat-1' }
      }
    });

    expect(state.lastResult).toMatchObject({
      status: 'failed',
      svn: { ok: true },
      unity: { ok: false, code: 1 },
      notification: { sent: false, status: 'failed', error: 'WebSocket not connected, unable to send data' }
    });
    expect(state.lastResult.unity.summary).toContain('compile error CS1002');

    const logContent = await fs.readFile(path.join(baizeRoot, 'runtime', 'unity-build-scheduler', 'runs.jsonl'), 'utf8');
    const logEntry = JSON.parse(logContent.trim());
    expect(logEntry).toMatchObject({
      status: 'failed',
      unity: { ok: false, code: 1 },
      notification: { sent: false, status: 'failed' }
    });
    expect(logEntry.unity.summary).toContain('compile error CS1002');
  });

  it('ticks only when server config and client state are both enabled and due', async () => {
    const { baizeRoot } = await createTestRoot();
    await setUnityBuildSchedulerEnabled(true, { clientId: 'desktop-1' }, { baizeRoot, now: new Date('2026-05-30T04:00:00.000Z') });
    const execFileImpl = createExecFileMock([
      { stdout: 'Cleanup finished.' },
      { stdout: 'Updated.' },
      { stdout: 'Last Changed Rev: 1' },
      { stdout: 'Build succeeded.' }
    ]);

    const result = await tickUnityBuildScheduler({
      baizeRoot,
      now: new Date('2026-05-30T04:30:00.000Z'),
      execFileImpl,
      config: {
        enabled: true,
        intervalMinutes: 10,
        workspacePath: 'D:/unity/project',
        svn: { enabled: true, updateArgs: ['update'], username: null, password: null },
        unityMcp: { command: 'unity-mcp', args: ['build'], timeoutMs: 120000 },
        notify: { enabled: false, webhookUrl: null, toUser: null, aiBotChatId: null }
      }
    });

    expect(result.skipped).toBe(false);
    expect(result.state.lastResult.status).toBe('success');
  });

  it('builds failure messages from Unity error output only', () => {
    const message = buildFailureMessage({
      startedAt: '2026-05-30T05:00:00.000Z',
      svnResult: { ok: true, stdout: 'Updated.', stderr: '' },
      buildResult: {
        ok: false,
        code: 1,
        stdout: 'normal output\nBuild completed with a result of Failed',
        stderr: 'Assets/Test.cs(1,1): error CS1002: ; expected at D:/unity/project/Assets/Test.cs',
        error: 'exit 1'
      }
    });

    expect(message).toContain('error CS1002');
    expect(message).toContain('[本机路径]');
    expect(message).toContain('Build completed with a result of Failed');
    expect(message).not.toContain('白泽 Unity 定时编译失败');
    expect(message).not.toContain('开始时间');
    expect(message).not.toContain('SVN 更新');
    expect(message).not.toContain('Unity MCP 编译');
    expect(message).not.toContain('normal output');
    expect(message).not.toContain('exit 1');
  });

  it('includes missing executeMethod errors in failure messages', () => {
    const message = buildFailureMessage({
      buildResult: {
        ok: false,
        code: 1,
        stdout: [
          'normal output',
          "executeMethod class 'OneKeyBuild' could not be found.",
          'Argument was -executeMethod Game.OneKeyBuild.BuildForAndroid_Batchmode',
          'Aborting batchmode due to failure:'
        ].join('\n'),
        stderr: '',
        error: 'Command failed: D:/Unity/Editor/Unity.exe'
      }
    });

    expect(message).toContain("executeMethod class 'OneKeyBuild' could not be found.");
    expect(message).toContain('Argument was -executeMethod Game.OneKeyBuild.BuildForAndroid_Batchmode');
    expect(message).toContain('Aborting batchmode due to failure:');
    expect(message).not.toContain('normal output');
    expect(message).not.toContain('Command failed');
  });
});
