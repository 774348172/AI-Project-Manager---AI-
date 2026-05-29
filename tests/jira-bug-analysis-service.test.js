const fs = require('fs/promises');
const path = require('path');
const childProcess = require('child_process');
const { createTestRoot } = require('./helpers/test-root');
const {
  buildBugJql,
  createBugAnalysisRun,
  confirmBugAnalysisRun,
  processDueBugAnalysisRuns,
  analyzeBugAnalysisItem,
  confirmBugAnalysisItemComment,
  applyBugAnalysisRecovery,
  enqueueBugAnalysisRun,
  createOrResumeBugAnalysisRun,
  getBugAnalysisRun
} = require('../src/services/jira-bug-analysis-service');

function mockSvnCommands() {
  return vi.spyOn(childProcess, 'execFile').mockImplementation((command, args, options, callback) => {
    callback(null, args[0] === 'update' ? 'Updated to revision 179805.\n' : '', '');
    return { kill: vi.fn() };
  });
}

async function seedConfig(baizeRoot) {
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
    'enabled: true',
    'baseURL: http://jira.example.test',
    'username: baize',
    'password: secret',
    'defaults:',
    '  projectKey: BZ'
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
    'enabled: true',
    'workspacePath: D:\\zenghaorang\\Robot_BaiZe',
    'bugAnalysisWorkspacePath: D:\\zenghaorang\\WorkSpace',
    'svn:',
    '  username: svn-user',
    '  password: svn-pass'
  ].join('\n'), 'utf8');
}

function createFetch() {
  const requests = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/rest/api/2/search')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          total: 1,
          issues: [{
            key: 'BZ-1',
            id: '10001',
            fields: {
              summary: '登录按钮无响应',
              status: { name: 'Open' },
              priority: { name: 'High' },
              labels: ['login'],
              created: '2026-05-01T00:00:00.000Z',
              updated: '2026-05-02T00:00:00.000Z'
            }
          }]
        })
      };
    }
    if (url.includes('/rest/api/2/issue/BZ-1?')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          key: 'BZ-1',
          id: '10001',
          fields: {
            summary: '登录按钮无响应',
            description: '点击登录后没有任何反馈。',
            status: { name: 'Open' },
            assignee: { displayName: '曾浩然' },
            reporter: { displayName: '测试' },
            priority: { name: 'High' },
            labels: ['login'],
            created: '2026-05-01T00:00:00.000Z',
            updated: '2026-05-02T00:00:00.000Z'
          }
        })
      };
    }
    if (url.endsWith('/rest/api/2/issue/BZ-1/comment')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 'comment-1', self: 'http://jira.example.test/comment-1' })
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  return { fetchImpl, requests };
}

describe('Jira Bug analysis service', () => {
  it('builds Bug JQL for a project', () => {
    expect(buildBugJql({ projectKey: 'BZ' })).toBe('project = "BZ" AND issuetype = Bug ORDER BY updated DESC');
  });

  it('creates a confirmed run, analyzes one item, and waits for comment confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    const svn = mockSvnCommands();
    const runner = vi.fn(async (input) => {
      expect(input.permissionMode).toBe('bug_analysis_workspace');
      expect(input.message.text).toContain('服务器已在启动本 BUG 子任务前执行受控 SVN 维护');
      expect(input.message.text).toContain('svn update --accept theirs-full');
      expect(input.message.text).toContain('不要再次执行 svn cleanup 或 svn update');
      expect(input.claudeCodeConfig.workspacePath).toBe('D:\\zenghaorang\\WorkSpace');
      expect(input.claudeCodeConfig.timeoutMs).toBeLessThanOrEqual(3600000);
      expect(input.claudeCodeConfig.timeoutMs).toBeGreaterThan(3500000);
      expect(input.memoryQuery).toContain('BZ-1');
      return '已完成 svn update。工程依据：src/renderer.js 登录按钮监听可能没有绑定，建议检查 renderer 登录按钮监听。';
    });

    const { run } = await createBugAnalysisRun({ projectKey: 'BZ', clientId: 'desktop-1' }, { baizeRoot, fetchImpl });
    expect(run).toMatchObject({ status: 'awaiting_confirmation', total: 1 });

    await confirmBugAnalysisRun(run.id, { clientId: 'desktop-1' }, { baizeRoot });
    const analyzed = await analyzeBugAnalysisItem(run.id, run.items[0].id, { baizeRoot, fetchImpl, claudeCodeRunner: runner });
    expect(svn).toHaveBeenCalledWith('svn', expect.arrayContaining(['--non-interactive', 'update', '--accept', 'theirs-full', 'D:\\zenghaorang\\WorkSpace', '--username', 'svn-user', '--password', 'svn-pass']), expect.objectContaining({ timeout: 600000 }), expect.any(Function));
    const item = analyzed.items[0];
    expect(item).toMatchObject({ status: 'awaiting_comment_confirmation', issueKey: 'BZ-1' });
    expect(item.commentDraft).toContain('baize:jira-bug-analysis');
    expect(item.commentDraft).toContain('登录按钮监听可能没有绑定');

    const commented = await confirmBugAnalysisItemComment(run.id, item.id, {}, { baizeRoot, fetchImpl });
    expect(commented).toMatchObject({ status: 'completed', completed: 1 });
    expect(commented.items[0]).toMatchObject({ status: 'completed', jiraComment: { id: 'comment-1' } });
  });

  it('activates scheduled runs from the scheduler tick', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    const runner = vi.fn(async () => '已完成 svn update。工程依据：src/renderer.js 定时分析结论。');
    const { run } = await createBugAnalysisRun({
      projectKey: 'BZ',
      scheduleAt: '2026-05-22T10:00:00.000Z'
    }, { baizeRoot, fetchImpl, now: new Date('2026-05-22T09:00:00.000Z') });

    const confirmed = await confirmBugAnalysisRun(run.id, {}, { baizeRoot, now: new Date('2026-05-22T09:00:00.000Z') });
    expect(confirmed.status).toBe('scheduled');

    const tick = await processDueBugAnalysisRuns({
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner,
      now: new Date('2026-05-22T10:00:00.000Z'),
      awaitBackground: true
    });

    expect(tick.activated).toHaveLength(1);
    expect(tick.enqueued[0]).toMatchObject({ status: 'running' });
  });

  it('rejects SVN-failure drafts that give up on engineering analysis', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    const runner = vi.fn(async () => 'svn update 失败。当前无法完成有效的工程级 Bug 分析。工程依据：src/renderer.js。');

    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot });
    await analyzeBugAnalysisItem(run.id, run.items[0].id, { baizeRoot, fetchImpl, claudeCodeRunner: runner });
    const latest = await getBugAnalysisRun(run.id, { baizeRoot });

    expect(latest.items[0]).toMatchObject({ status: 'pending', attempt: 1 });
    expect(latest.items[0].error).toContain('放弃工程分析');
  });

  it('continues engineering analysis when SVN update fails', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    vi.spyOn(childProcess, 'execFile').mockImplementation((command, args, options, callback) => {
      if (args.includes('update')) {
        callback(Object.assign(new Error('Authentication failed'), { code: 1 }), '', 'svn: E215004: Authentication failed\n');
        return { kill: vi.fn() };
      }
      callback(null, '', '');
      return { kill: vi.fn() };
    });
    const runner = vi.fn(async (input) => {
      expect(input.message.text).toContain('SVN 维护结果');
      expect(input.message.text).toContain('Authentication failed');
      expect(input.message.text).toContain('仍必须基于当前可读取的工程工作副本继续进行工程级分析');
      expect(input.message.text).toContain('禁止写“无法完成工程级分析”');
      return 'SVN 更新失败：Authentication failed。当前分析依据来自未完成更新的本地工程状态。工程依据：src/renderer.js 登录按钮监听可能没有绑定。';
    });

    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot });
    const analyzed = await analyzeBugAnalysisItem(run.id, run.items[0].id, { baizeRoot, fetchImpl, claudeCodeRunner: runner });

    expect(analyzed.items[0]).toMatchObject({ status: 'awaiting_comment_confirmation' });
    expect(analyzed.items[0].commentDraft).toContain('SVN 更新失败');
  });

  it('does not reuse runs that are awaiting comment confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    const runner = vi.fn(async () => '已完成 svn update。工程依据：src/renderer.js 生成旧草稿。');

    const first = await createOrResumeBugAnalysisRun({ issueKeys: ['BZ-1'], clientId: 'desktop-1' }, { baizeRoot, fetchImpl, claudeCodeRunner: runner, awaitBackground: true });
    const firstLatest = await getBugAnalysisRun(first.run.id, { baizeRoot });
    expect(firstLatest.status).toBe('awaiting_comment_confirmation');

    const second = await createOrResumeBugAnalysisRun({ issueKeys: ['BZ-1'], clientId: 'desktop-1' }, { baizeRoot, fetchImpl, claudeCodeRunner: runner, awaitBackground: false });

    expect(second.reused).toBe(false);
    expect(second.run.id).not.toBe(firstLatest.id);
  });

  it('automatically retries failed item analysis up to ten attempts', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    let attempts = 0;
    const runner = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('temporary timeout');
      }
      return '已完成 svn update。工程依据：src/renderer.js 自动重试后完成分析。';
    });

    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot });
    await enqueueBugAnalysisRun(run.id, { baizeRoot, fetchImpl, claudeCodeRunner: runner, awaitBackground: true });
    const latest = await getBugAnalysisRun(run.id, { baizeRoot });

    expect(latest.items[0].status).toBe('awaiting_comment_confirmation');
    expect(latest.items[0].attempt).toBe(3);
  });

  it('marks active analyzing items failed after the one-hour item timeout', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    let resolveRunner;
    const runnerPromise = new Promise((resolve) => {
      resolveRunner = resolve;
    });
    const runner = vi.fn(() => runnerPromise);

    const now = new Date('2026-05-22T10:00:00.000Z');
    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl, now });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot, now });
    const background = analyzeBugAnalysisItem(run.id, run.items[0].id, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner,
      now
    });
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalled();
    });

    await processDueBugAnalysisRuns({
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner,
      now: new Date('2026-05-22T11:00:01.000Z')
    });
    const timedOut = await getBugAnalysisRun(run.id, { baizeRoot });

    expect(timedOut).toMatchObject({ status: 'partial_failed' });
    expect(timedOut.items[0]).toMatchObject({ status: 'recovery_required', analysisStartedAt: null });
    expect(timedOut.items[0].error).toContain('超过 60 分钟超时时间');
    expect(timedOut.items[0].recovery.actions.map((action) => action.id)).not.toContain('retry_analysis');

    resolveRunner('已完成 svn update。工程依据：src/renderer.js 超时后返回不应复活。');
    await background;
  });

  it('does not reset active analyzing items during resume before item timeout', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    let resolveRunner;
    const runnerPromise = new Promise((resolve) => {
      resolveRunner = resolve;
    });
    const runner = vi.fn(() => runnerPromise);

    const now = new Date('2026-05-22T10:00:00.000Z');
    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl, now });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot, now });
    const background = analyzeBugAnalysisItem(run.id, run.items[0].id, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner,
      now
    });
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalled();
    });
    const analyzing = await getBugAnalysisRun(run.id, { baizeRoot });
    expect(analyzing.items[0]).toMatchObject({ status: 'analyzing', attempt: 1 });

    const tick = await processDueBugAnalysisRuns({
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner,
      now: new Date('2026-05-22T10:30:00.000Z')
    });
    const duringAnalysis = await getBugAnalysisRun(run.id, { baizeRoot });

    expect(tick.enqueued).toHaveLength(1);
    expect(duringAnalysis.items[0]).toMatchObject({ status: 'analyzing', attempt: 1 });

    resolveRunner('已完成 svn update。工程依据：src/renderer.js 未打断运行中的分析。');
    await background;
  });

  it('does not revive a cancelled run when an active item fails afterward', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    let rejectRunner;
    const runnerPromise = new Promise((resolve, reject) => {
      rejectRunner = reject;
    });
    const runner = vi.fn(() => runnerPromise);

    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot });
    const background = analyzeBugAnalysisItem(run.id, run.items[0].id, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner
    });
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });

    const indexPath = path.join(baizeRoot, 'runtime', 'bug-analysis', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index.runs = index.runs.map((current) => current.id === run.id
      ? {
          ...current,
          status: 'cancelled',
          finishedAt: '2026-05-22T10:10:00.000Z',
          items: current.items.map((item) => ({
            ...item,
            status: 'skipped',
            analysisStartedAt: null
          }))
        }
      : current);
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

    rejectRunner(new Error('killed after cancellation'));
    const result = await background;

    expect(result.status).toBe('cancelled');
    expect(result.items[0]).toMatchObject({ status: 'skipped', analysisStartedAt: null });
  });

  it('does not run BUG analysis items from different runs concurrently', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    mockSvnCommands();
    let resolveRunner;
    const runnerPromise = new Promise((resolve) => {
      resolveRunner = resolve;
    });
    const runner = vi.fn(() => runnerPromise);

    const first = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    const second = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    await confirmBugAnalysisRun(first.run.id, {}, { baizeRoot });
    await confirmBugAnalysisRun(second.run.id, {}, { baizeRoot });

    const firstBackground = analyzeBugAnalysisItem(first.run.id, first.run.items[0].id, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner
    });
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });

    const secondResult = await analyzeBugAnalysisItem(second.run.id, second.run.items[0].id, {
      baizeRoot,
      fetchImpl,
      claudeCodeRunner: runner
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(secondResult.items[0]).toMatchObject({ status: 'pending', attempt: 0 });

    resolveRunner('已完成 svn update。工程依据：src/renderer.js 全局串行分析。');
    await firstBackground;
  });

  it('keeps recovery actions on the server whitelist', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const { fetchImpl } = createFetch();
    const { run } = await createBugAnalysisRun({ projectKey: 'BZ' }, { baizeRoot, fetchImpl });
    await confirmBugAnalysisRun(run.id, {}, { baizeRoot });

    await expect(applyBugAnalysisRecovery(run.id, run.items[0].id, { actionId: 'run_arbitrary_shell' }, { baizeRoot }))
      .rejects.toMatchObject({ code: 'INVALID_RECOVERY_ACTION' });
  });
});
