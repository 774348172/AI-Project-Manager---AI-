const fs = require('fs/promises');
const path = require('path');
const childProcess = require('child_process');
const { createTestRoot } = require('./helpers/test-root');
const {
  createRequirementCompletionRun,
  generateRequirementCompletionPlan,
  confirmAndEnqueueRequirementCompletionRun,
  getRequirementCompletionRun,
  applyRequirementCompletionRecovery
} = require('../src/services/requirement-completion-service');

function mockSvnCommands() {
  return vi.spyOn(childProcess, 'execFile').mockImplementation((command, args, options, callback) => {
    callback(null, args[0] === 'update' ? 'Updated to revision 179805.\n' : '', '');
    return { kill: vi.fn() };
  });
}

async function seedConfig(baizeRoot) {
  await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
    'enabled: true',
    'workspacePath: D:\\zenghaorang\\Robot_BaiZe',
    'bugAnalysisWorkspacePath: D:\\zenghaorang\\WorkSpace',
    'requirementCompletionWorkspacePath: D:\\zenghaorang\\RequirementWorkSpace',
    'svn:',
    '  username: svn-user',
    '  password: svn-pass'
  ].join('\n'), 'utf8');
}

describe('Requirement completion service', () => {
  it('generates a server-side engineering plan and executes after confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    const svn = mockSvnCommands();
    const runner = vi.fn(async (input) => {
      if (input.permissionMode === 'requirement_completion_plan') {
        expect(input.message.text).toContain('需求内容');
        expect(input.message.text).toContain('svn update --accept theirs-full');
        expect(input.claudeCodeConfig.workspacePath).toBe('D:\\zenghaorang\\RequirementWorkSpace');
        return '需求理解：增加登录提示。工程依据来源：src/app.js 当前登录处理。实施步骤：修改 src/app.js 的登录提示。预计修改文件或模块：src/app.js。验证方案：运行 node --check src/app.js。风险：需确认文案。';
      }
      expect(input.permissionMode).toBe('requirement_completion_execution');
      expect(input.confirmedPlan).toContain('预计修改文件');
      return '完成报告：已实现。工程依据来源：src/app.js。修改文件：src/app.js。验证结果：node --check src/app.js 通过。未完成风险：无。';
    });

    const { run } = await createRequirementCompletionRun({ requirementText: '把登录失败提示改得更清晰', title: '优化登录提示', clientId: 'desktop-1' }, { baizeRoot });
    expect(run).toMatchObject({ status: 'awaiting_plan', title: '优化登录提示' });

    const planned = await generateRequirementCompletionPlan(run.id, {}, { baizeRoot, claudeCodeRunner: runner });
    expect(planned.status).toBe('awaiting_execution_confirmation');
    expect(planned.plan.text).toContain('src/app.js');
    expect(svn).toHaveBeenCalledWith('svn', expect.arrayContaining(['--non-interactive', 'update', '--accept', 'theirs-full', 'D:\\zenghaorang\\RequirementWorkSpace', '--username', 'svn-user', '--password', 'svn-pass']), expect.objectContaining({ timeout: 600000 }), expect.any(Function));

    const confirmed = await confirmAndEnqueueRequirementCompletionRun(run.id, { clientId: 'desktop-1' }, { baizeRoot, claudeCodeRunner: runner, awaitBackground: true });
    const latest = await getRequirementCompletionRun(run.id, { baizeRoot });

    expect(confirmed.enqueued).toBe(true);
    expect(latest.status).toBe('completed');
    expect(latest.executionResult.reply).toContain('验证结果');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('keeps failed plans recoverable', async () => {
    const { baizeRoot } = await createTestRoot();
    await seedConfig(baizeRoot);
    mockSvnCommands();
    const runner = vi.fn(async () => '只说想法，没有工程依据。');

    const { run } = await createRequirementCompletionRun({ requirementText: '新增需求入口' }, { baizeRoot });
    const planned = await generateRequirementCompletionPlan(run.id, {}, { baizeRoot, claudeCodeRunner: runner });

    expect(planned.status).toBe('plan_failed');
    expect(planned.recovery.actions.map((action) => action.id)).toContain('retry_plan');

    const cancelled = await applyRequirementCompletionRecovery(run.id, { actionId: 'cancel_run' }, { baizeRoot });
    expect(cancelled.status).toBe('cancelled');
  });
});
