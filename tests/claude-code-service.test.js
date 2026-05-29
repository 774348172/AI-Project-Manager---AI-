const { EventEmitter } = require('events');
const path = require('path');
const { PassThrough } = require('stream');
const {
  buildClaudeCodePrompt,
  buildClaudeCodeWriteProposalPrompt,
  buildClaudeCodeOperationIntentPrompt,
  buildClaudeCodeExecutionErrorAnalysisPrompt,
  buildClaudeCodeJiraSearchErrorAnalysisPrompt,
  buildClaudeCodeEnv,
  createClaudeCodeCliRunner,
  parseClaudeCodePatchProposal,
  parseClaudeCodeOperationIntent,
  parseClaudeCodePluginOperationRecovery,
  parseClaudeCodeExecutionRecovery,
  parseClaudeCodeJiraSearchRecovery,
  parseClaudeCodeJiraWriteRecovery,
  runClaudeCodeTask
} = require('../src/services/claude-code-service');

describe('Claude Code service', () => {
  it('builds a readonly Baize context prompt', () => {
    const prompt = buildClaudeCodePrompt({
      message: { text: '分析聊天接口' },
      conversationMessages: [{ role: 'user', text: '你好' }],
      conversationSummary: '用户正在检查聊天链路。',
      knowledgeResults: [{ title: 'chat', snippet: '聊天接口说明' }],
      shallowMemoryResults: [{ category: 'project', line: '白泽是服务器中枢' }],
      logicContext: {
        assertions: [{ category: 'project', content: '分析 Jira Bug 前必须更新 SVN。' }],
        rules: [{ name: 'identity', content: '保持白泽身份' }],
        executableRules: [{ name: 'routing-rules', content: 'rules:\n  - name: route-chat' }]
      },
      skillsContext: { skills: [{ id: 'jira', skillMarkdown: 'Jira 技能' }] },
      attachments: [{
        id: 'att-1',
        fileName: 'JUMP需求收集表.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        type: 'spreadsheet',
        size: 128,
        storagePath: 'D:\\zenghaorang\\Robot_BaiZe\\baize\\uploads\\att-1\\JUMP需求收集表.xlsx',
        readPath: 'D:/zenghaorang/Robot_BaiZe/baize/uploads/att-1/JUMP需求收集表.xlsx',
        summary: '表格摘要',
        semanticExtraction: {
          kind: 'xlsx_semantic_text',
          source: 'server',
          extractorVersion: 1,
          truncated: false,
          sheetCount: 1,
          includedSheetCount: 1,
          text: '工作表：需求池\nR2 | A(A2)=战斗 | B(B2)=JUMP 战斗结算优化'
        }
      }]
    });

    expect(prompt).toContain('当前模式为只读或意图解析');
    expect(prompt).toContain('必须先阅读逻辑官上下文');
    expect(prompt).toContain('用户问题：分析聊天接口');
    expect(prompt).toContain('聊天接口说明');
    expect(prompt).toContain('白泽是服务器中枢');
    expect(prompt).toContain('分析 Jira Bug 前必须更新 SVN');
    expect(prompt).toContain('保持白泽身份');
    expect(prompt).toContain('route-chat');
    expect(prompt).toContain('Jira 技能');
    expect(prompt).toContain('附件上下文');
    expect(prompt).toContain('附件 ID：att-1');
    expect(prompt).toContain('可读取路径：D:/zenghaorang/Robot_BaiZe/baize/uploads/att-1/JUMP需求收集表.xlsx');
    expect(prompt).toContain('服务器高保真表格抽取');
    expect(prompt).toContain('R2 | A(A2)=战斗');
    expect(prompt).toContain('遇到 xlsx 等二进制表格时，可以用 Bash 调用 Python/Node');
  });

  it('runs an injected readonly runner and streams the final reply', async () => {
    const deltas = [];
    const events = [];
    let runnerInput;

    const reply = await runClaudeCodeTask({
      message: { text: '分析聊天接口' },
      permissionMode: 'read_only',
      runner: async (input) => {
        runnerInput = input;
        return '白泽：Claude Code 只读分析完成。';
      },
      onDelta: (text) => deltas.push(text),
      onEvent: (event) => events.push(event)
    });

    expect(reply).toBe('白泽：Claude Code 只读分析完成。');
    expect(deltas).toEqual(['白泽：Claude Code 只读分析完成。']);
    expect(events).toEqual([expect.objectContaining({ type: 'status' })]);
    expect(runnerInput.prompt).toContain('分析聊天接口');
    expect(runnerInput.permissionMode).toBe('read_only');
  });

  it('builds a write proposal prompt without granting write tools', () => {
    const prompt = buildClaudeCodeWriteProposalPrompt({ message: { text: '帮我修改错误提示' } });

    expect(prompt).toContain('生成补丁草案');
    expect(prompt).toContain('只能输出 unified diff');
    expect(prompt).toContain('不能实际修改文件');
  });

  it('runs an injected write proposal runner and validates the patch', async () => {
    let runnerInput;
    const proposal = await runClaudeCodeTask({
      message: { text: '帮我修改 src/app.js' },
      permissionMode: 'write_proposal',
      runner: async (input) => {
        runnerInput = input;
        return JSON.stringify({
          summary: '更新 app 文案。',
          patch: [
            'diff --git a/src/app.js b/src/app.js',
            '--- a/src/app.js',
            '+++ b/src/app.js',
            '@@ -1 +1 @@',
            '-old',
            '+new'
          ].join('\n'),
          warnings: ['请运行测试。']
        });
      }
    });

    expect(runnerInput.permissionMode).toBe('write_proposal');
    expect(runnerInput.prompt).toContain('生成补丁草案');
    expect(proposal).toEqual({
      summary: '更新 app 文案。',
      patch: expect.stringContaining('diff --git a/src/app.js b/src/app.js'),
      files: [{ path: 'src/app.js', changeType: 'modify', additions: 1, deletions: 1 }],
      warnings: ['请运行测试。']
    });
  });

  it('rejects unsafe write proposal patches', () => {
    expect(() => parseClaudeCodePatchProposal(JSON.stringify({
      summary: '修改敏感配置。',
      patch: [
        'diff --git a/.env b/.env',
        '--- a/.env',
        '+++ b/.env',
        '@@ -1 +1 @@',
        '-a',
        '+b'
      ].join('\n')
    }))).toThrow('补丁不能修改密钥或敏感配置文件。');
  });

  it('builds an operation intent prompt requiring English Jira draft fields', () => {
    const prompt = buildClaudeCodeOperationIntentPrompt({
      message: { text: '根据 xlsx 创建 Jira 单' },
      attachments: [{ fileName: 'JUMP需求收集表.xlsx', readPath: 'D:/tmp/JUMP需求收集表.xlsx', summary: '截断摘要' }]
    });

    expect(prompt).toContain('优先使用附件上下文里的服务器高保真表格抽取');
    expect(prompt).toContain('必须读取附件上下文里的原始可读取路径兜底');
    expect(prompt).toContain('不要只依据上传分析摘要生成草稿');
    expect(prompt).toContain('必须使用英文字段名 summary、description、projectKey、issueType、assignee、priority、labels');
    expect(prompt).toContain('必须使用 node -e 或 python -c 单行只读命令');
    expect(prompt).toContain('jira_bug_analysis');
    expect(prompt).toContain('启动或恢复服务器后台工程级 BUG 分析任务');
  });

  it('parses Jira BUG analysis intent from Claude Code output', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bug_analysis',
      reply: '准备启动分析。',
      issueKeys: ['BUG-5983', 'BUG-6798', 'BUG-5983']
    }));

    expect(intent).toEqual({
      kind: 'jira_bug_analysis',
      reply: '准备启动分析。',
      issueKeys: ['BUG-5983', 'BUG-6798']
    });
  });

  it('parses Jira BUG analysis intent from single issueKey and entries', () => {
    expect(parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bug_analysis',
      issueKey: 'BUG-5983'
    }))).toMatchObject({ issueKeys: ['BUG-5983'] });

    expect(parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bug_analysis',
      entries: [{ issueKey: 'BUG-6798' }]
    }))).toMatchObject({ issueKeys: ['BUG-6798'] });
  });

  it('rejects invalid Jira BUG analysis intents', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bug_analysis',
      issueKeys: []
    }))).toThrow('Claude Code BUG 分析意图缺少 Jira 单号。');

    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bug_analysis',
      issueKeys: ['bug-1']
    }))).toThrow('Claude Code BUG 分析意图包含非法 Jira 单号。');

    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bug_analysis',
      issueKeys: Array.from({ length: 51 }, (_, index) => `BUG-${index + 1}`)
    }))).toThrow('Claude Code BUG 分析意图单号超出 50 条上限。');
  });

  it('parses Jira search status arrays from Claude Code output', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_search',
      query: {
        projectKey: 'BUG',
        assignee: '曾浩然',
        status: ['未开始', '处理中']
      }
    }));

    expect(intent).toMatchObject({
      kind: 'jira_search',
      query: {
        projectKey: 'BUG',
        assignee: '曾浩然',
        status: ['未开始', '处理中']
      }
    });
  });

  it('accepts Chinese Jira draft fields from Claude Code output', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bulk_create',
      drafts: [{
        标题: '关卡相机表现流程控制',
        描述: '关卡表演 TimeLine 维护方案',
        项目: 'BATTLE',
        类型: '任务',
        处理人: '曾浩然',
        优先级: '极高'
      }]
    }));

    expect(intent).toMatchObject({
      kind: 'jira_bulk_create',
      drafts: [{
        summary: '关卡相机表现流程控制',
        description: '关卡表演 TimeLine 维护方案',
        projectKey: 'BATTLE',
        issueType: '任务',
        assignee: '曾浩然',
        priority: '极高'
      }]
    });
  });

  it('repairs malformed operation intent output once', async () => {
    const runnerInputs = [];
    const timings = {};
    const events = [];

    const intent = await runClaudeCodeTask({
      message: { text: '根据 xlsx 创建 Jira 单' },
      permissionMode: 'operation_intent',
      runner: async (input) => {
        runnerInputs.push(input);
        if (runnerInputs.length === 1) {
          return JSON.stringify({ kind: 'jira_bulk_create', drafts: [{ 描述: '缺少标题' }] });
        }
        return JSON.stringify({
          kind: 'jira_bulk_create',
          reply: '已修复 Jira 草稿。',
          drafts: [{
            summary: '关卡相机表现流程控制',
            description: '关卡表演 TimeLine 维护方案',
            projectKey: 'BATTLE',
            issueType: '任务'
          }]
        });
      },
      onTiming: (key, value) => {
        timings[key] = value;
      },
      onEvent: (event) => events.push(event)
    });

    expect(runnerInputs).toHaveLength(2);
    expect(runnerInputs[1].prompt).toContain('上一次 Claude Code 操作意图输出没有通过服务器解析');
    expect(runnerInputs[1].prompt).toContain('Claude Code 没有生成可确认的 Jira 草稿。');
    expect(runnerInputs[1].prompt).toContain('summary');
    expect(timings.claudeCodeRepairAttempted).toBe(1);
    expect(typeof timings.claudeCodeRepairMs).toBe('number');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '白泽正在让 Claude Code 修复操作意图格式。' })
    ]));
    expect(intent).toMatchObject({
      kind: 'jira_bulk_create',
      reply: '已修复 Jira 草稿。',
      drafts: [{
        summary: '关卡相机表现流程控制',
        description: '关卡表演 TimeLine 维护方案',
        projectKey: 'BATTLE',
        issueType: '任务'
      }]
    });
  });

  it('builds Claude Code execution recovery analysis prompts', () => {
    const prompt = buildClaudeCodeExecutionErrorAnalysisPrompt({
      message: { text: '根据这个文本创建jira需求' },
      attachments: [{ fileName: 'JUMP需求收集表.xlsx', readPath: 'D:/tmp/JUMP需求收集表.xlsx' }]
    }, {
      stage: 'operation_intent',
      expectedKind: 'jira_bulk_create',
      originalOutput: 'Bash 只读解析命令被当前权限模式拒绝。',
      errorMessage: '当前请求必须生成 Jira 草稿'
    });

    expect(prompt).toContain('请只做只读自诊断');
    expect(prompt).toContain('允许工具：Read,Grep,Glob,Bash');
    expect(prompt).toContain('retry_with_strict_command_template');
    expect(prompt).toContain('Bash 只读解析命令被当前权限模式拒绝。');
  });

  it('parses Claude Code execution recovery JSON with whitelisted actions', () => {
    const recovery = parseClaudeCodeExecutionRecovery(JSON.stringify({
      kind: 'claude_code_execution_recovery',
      stage: 'operation_intent',
      expectedKind: 'jira_bulk_create',
      status: 'retry_available',
      summary: '可以按 Node 单行命令重试。',
      reason: '上次没有真正执行允许的 Bash 命令。',
      action: { id: 'retry_with_node_template', label: '使用 Node 重试', requiresConfirmation: false }
    }), { stage: 'operation_intent', expectedKind: 'jira_bulk_create' });

    expect(recovery).toMatchObject({
      status: 'retry_available',
      analyzedBy: 'claude_code',
      stage: 'operation_intent',
      expectedKind: 'jira_bulk_create',
      action: { id: 'retry_with_node_template', requiresConfirmation: false }
    });
  });

  it('rejects unsupported Claude Code execution recovery actions', () => {
    expect(() => parseClaudeCodeExecutionRecovery(JSON.stringify({
      kind: 'claude_code_execution_recovery',
      stage: 'operation_intent',
      expectedKind: 'jira_bulk_create',
      status: 'retry_available',
      action: { id: 'run_arbitrary_shell' }
    }), { stage: 'operation_intent', expectedKind: 'jira_bulk_create' })).toThrow('Claude Code 没有生成可用的执行恢复动作。');
  });

  it('analyzes Jira create operation failures before retrying', async () => {
    const runnerInputs = [];
    const timings = {};
    const events = [];

    const intent = await runClaudeCodeTask({
      message: { text: '根据这个文本创建jira需求' },
      route: { intent: { route: 'jira_create' } },
      permissionMode: 'operation_intent',
      runner: async (input) => {
        runnerInputs.push(input);
        if (runnerInputs.length === 1) {
          return JSON.stringify({
            kind: 'engineering_reply',
            reply: '这是创建 Jira 需求的意图，但当前无法生成合规草稿：Bash 只读解析命令被当前权限模式拒绝。'
          });
        }
        if (runnerInputs.length === 2) {
          return JSON.stringify({
            kind: 'claude_code_execution_recovery',
            stage: 'operation_intent',
            expectedKind: 'jira_bulk_create',
            status: 'retry_available',
            summary: '上次没有真正执行允许的单行命令。',
            reason: '应按 Node 单行命令读取原始附件。',
            action: { id: 'retry_with_node_template', label: '使用 Node 重试', requiresConfirmation: false }
          });
        }
        return JSON.stringify({
          kind: 'jira_bulk_create',
          drafts: [{ summary: '重试后的 Jira 需求', projectKey: 'BZ', issueType: 'Task', labels: [] }]
        });
      },
      onTiming: (key, value) => {
        timings[key] = value;
      },
      onEvent: (event) => events.push(event)
    });

    expect(runnerInputs).toHaveLength(3);
    expect(runnerInputs[0].prompt).toContain('本轮不能返回 engineering_reply');
    expect(runnerInputs[1].permissionMode).toBe('claude_code_execution_error_analysis');
    expect(runnerInputs[1].prompt).toContain('请只做只读自诊断');
    expect(runnerInputs[2].prompt).toContain('Claude Code 自诊断：上次没有真正执行允许的单行命令。');
    expect(runnerInputs[2].prompt).toContain('恢复动作：retry_with_node_template');
    expect(runnerInputs[2].prompt).toContain('优先使用 node -e 单行命令');
    expect(timings.claudeCodeExecutionRecoveryAttempted).toBe(1);
    expect(typeof timings.claudeCodeExecutionRecoveryMs).toBe('number');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '白泽正在让 Claude Code 分析自己的执行失败。' }),
      expect.objectContaining({ message: '白泽正在按 Claude Code 自诊断结果重试。' })
    ]));
    expect(intent).toMatchObject({
      kind: 'jira_bulk_create',
      drafts: [expect.objectContaining({ summary: '重试后的 Jira 需求' })]
    });
  });

  it('parses plugin operation recovery JSON', () => {
    const operation = { id: 'jira-op-1' };
    const recovery = parseClaudeCodePluginOperationRecovery(JSON.stringify({
      kind: 'plugin_operation_recovery',
      plugin: 'jira',
      operationId: 'jira-op-1',
      status: 'available',
      summary: '可以移除标签后重试。',
      reason: 'labels 不在创建界面。',
      actions: [
        { id: 'retry_without_labels', label: '移除标签后重试创建', style: 'primary', requiresConfirmation: true },
        { id: 'cancel', label: '取消创建', style: 'secondary' }
      ]
    }), operation);

    expect(recovery).toMatchObject({
      status: 'available',
      analyzedBy: 'claude_code',
      summary: '可以移除标签后重试。',
      actions: [
        expect.objectContaining({ id: 'retry_without_labels', requiresConfirmation: true }),
        expect.objectContaining({ id: 'cancel', requiresConfirmation: false })
      ]
    });
  });

  it('rejects plugin operation recovery JSON for another operation', () => {
    expect(() => parseClaudeCodePluginOperationRecovery(JSON.stringify({
      kind: 'plugin_operation_recovery',
      plugin: 'jira',
      operationId: 'other-op',
      status: 'available',
      actions: [{ id: 'cancel' }]
    }), { id: 'jira-op-1' })).toThrow('Claude Code 插件恢复意图与当前操作不匹配。');
  });

  it('repairs malformed plugin recovery output once', async () => {
    const runnerInputs = [];
    const recovery = await runClaudeCodeTask({
      message: { text: '确认创建 Jira 单' },
      permissionMode: 'plugin_operation_error_analysis',
      operation: { id: 'jira-op-1', failure: { classification: { safeDefaultRecovery: 'retry_without_labels' } } },
      runner: async (input) => {
        runnerInputs.push(input);
        if (runnerInputs.length === 1) {
          return JSON.stringify({ kind: 'plugin_operation_recovery', plugin: 'jira', operationId: 'other-op', status: 'available', actions: [{ id: 'cancel' }] });
        }
        return JSON.stringify({
          kind: 'plugin_operation_recovery',
          plugin: 'jira',
          operationId: 'jira-op-1',
          status: 'available',
          summary: '移除 labels 后重试。',
          actions: [{ id: 'retry_without_labels', label: '重试' }, { id: 'cancel', label: '取消' }]
        });
      }
    });

    expect(runnerInputs).toHaveLength(2);
    expect(runnerInputs[1].prompt).toContain('上一次 Claude Code 插件错误恢复分析输出没有通过服务器解析');
    expect(recovery).toMatchObject({ status: 'available', actions: expect.arrayContaining([expect.objectContaining({ id: 'retry_without_labels' })]) });
  });

  it('loads Claude Code env from settings and explicit config', async () => {
    const settingsPath = path.join(process.cwd(), '.test-claude-settings.json');
    await require('fs/promises').writeFile(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://example.test/',
        ANTHROPIC_AUTH_TOKEN: 'settings-token'
      }
    }), 'utf8');

    try {
      const env = buildClaudeCodeEnv({
        settingsPath,
        env: { ANTHROPIC_AUTH_TOKEN: 'override-token' }
      });

      expect(env.ANTHROPIC_BASE_URL).toBe('https://example.test/');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('override-token');
    } finally {
      await require('fs/promises').unlink(settingsPath);
    }
  });

  it('runs Claude Code CLI with readonly tools only', async () => {
    let spawnCall;
    const spawnImpl = (command, args, options) => {
      spawnCall = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      process.nextTick(() => {
        child.stdout.write('白泽：真实 Claude Code 只读分析完成。');
        child.stdout.end();
        child.emit('close', 0);
      });
      return child;
    };

    const runner = createClaudeCodeCliRunner({ spawnImpl });
    const reply = await runner({
      prompt: '分析聊天接口',
      claudeCodeConfig: {
        command: 'claude-test',
        timeoutMs: 1000,
        settingsPath: 'C:/Users/Administrator/.claude/settings.json',
        workspacePath: process.cwd()
      }
    });

    expect(reply).toBe('白泽：真实 Claude Code 只读分析完成。');
    expect(spawnCall.command).toBe('claude-test');
    expect(spawnCall.args).toEqual(expect.arrayContaining([
      '--print',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob,Bash',
      '--allowedTools',
      'Read,Grep,Glob,Bash(python *),Bash(python - *),Bash(python3 *),Bash(python3 - *),Bash(py *),Bash(py - *),Bash(node *),Bash(node - *)',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
      '--settings',
      'C:/Users/Administrator/.claude/settings.json'
    ]));
    expect(spawnCall.args.slice(0, 2)).toEqual(['--print', '分析聊天接口']);
    expect(spawnCall.options.cwd).toBe(process.cwd());
    expect(spawnCall.options.windowsHide).toBe(true);
  });

  it('runs Claude Code CLI with readonly BUG analysis workspace tools and fast model', async () => {
    let spawnCall;
    const spawnImpl = (command, args, options) => {
      spawnCall = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      process.nextTick(() => {
        child.stdout.write('白泽：BUG 工程分析完成。');
        child.stdout.end();
        child.emit('close', 0);
      });
      return child;
    };

    const runner = createClaudeCodeCliRunner({ spawnImpl });
    const reply = await runner({
      prompt: '分析 BUG',
      permissionMode: 'bug_analysis_workspace',
      claudeCodeConfig: {
        command: 'claude-test',
        timeoutMs: 1000,
        bugAnalysisModel: 'claude-opus-4-7',
        workspacePath: process.cwd(),
        bugAnalysisWorkspacePath: 'D:/zenghaorang/WorkSpace',
        claudeHomePath: 'C:/Users/Administrator/.claude'
      }
    });

    expect(reply).toBe('白泽：BUG 工程分析完成。');
    expect(spawnCall.args).toEqual(expect.arrayContaining([
      '--tools',
      'Read,Grep,Glob,Bash',
      '--allowedTools',
      expect.stringContaining('Bash(svn status *)'),
      '--disallowedTools',
      expect.stringContaining('Bash(svn update *)'),
      '--model',
      'claude-opus-4-7'
    ]));
    expect(spawnCall.args.join(' ')).not.toContain('Read,Grep,Glob,Bash,Edit,Write,NotebookEdit');
    expect(spawnCall.options.cwd.replace(/\\/g, '/')).toBe('D:/zenghaorang/WorkSpace');
  });

  it('returns a Chinese error when Claude Code command is missing', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      process.nextTick(() => {
        const error = new Error('not found');
        error.code = 'ENOENT';
        child.emit('error', error);
      });
      return child;
    };

    const runner = createClaudeCodeCliRunner({ spawnImpl });

    await expect(runner({ prompt: '分析', claudeCodeConfig: { command: 'missing-claude', timeoutMs: 1000 } }))
      .rejects.toMatchObject({
        code: 'CLAUDE_CODE_NOT_FOUND',
        publicMessage: '服务器没有找到 Claude Code 命令，请确认已安装并配置到 PATH。'
      });
  });

  it('rejects non-readonly permission modes', async () => {
    await expect(runClaudeCodeTask({
      message: { text: '修改文件' },
      permissionMode: 'write'
    })).rejects.toMatchObject({
      code: 'CLAUDE_CODE_PERMISSION_DENIED',
      publicMessage: 'Claude Code 当前不允许这个权限模式。'
    });
  });

  it('parses jira_update_issue intent', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_update_issue',
      reply: '改优先级',
      issueKey: 'BUG-1',
      fields: { priority: { name: '高' } }
    }));
    expect(intent).toMatchObject({ kind: 'jira_update_issue', issueKey: 'BUG-1', fields: { priority: { name: '高' } } });
  });

  it('rejects jira_update_issue intents missing fields', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_update_issue', issueKey: 'BUG-1', fields: {}
    }))).toThrow();
  });

  it('parses jira_transition_issue intent with transition.name', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_transition_issue', issueKey: 'BUG-1', transition: { name: '开始处理' }
    }));
    expect(intent).toMatchObject({ kind: 'jira_transition_issue', issueKey: 'BUG-1', transition: { name: '开始处理' } });
  });

  it('rejects jira_transition_issue without id or name', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_transition_issue', issueKey: 'BUG-1', transition: {}
    }))).toThrow();
  });

  it('parses jira_delete_issue intent and dedupes', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_delete_issue', issueKeys: ['BUG-1', 'BUG-1', 'BUG-2']
    }));
    expect(intent.issueKeys).toEqual(['BUG-1', 'BUG-2']);
  });

  it('parses jira_write_recovery JSON with retry_with_unchanged_payload', () => {
    const recovery = parseClaudeCodeJiraWriteRecovery(JSON.stringify({
      kind: 'jira_write_recovery',
      plugin: 'jira',
      status: 'retry_available',
      summary: '可重试',
      action: { id: 'retry_with_unchanged_payload', label: '重试', requiresConfirmation: false }
    }));
    expect(recovery).toMatchObject({ status: 'retry_available', action: { id: 'retry_with_unchanged_payload' } });
  });

  it('rejects jira_write_recovery actions outside whitelist', () => {
    expect(() => parseClaudeCodeJiraWriteRecovery(JSON.stringify({
      kind: 'jira_write_recovery', plugin: 'jira', status: 'retry_available',
      action: { id: 'run_arbitrary' }
    }))).toThrow();
  });

  it('parses jira_delete_comment intent with targets and filterScope', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_delete_comment',
      reply: '已识别为删评论意图。',
      targets: [
        { issueKey: 'BATTLE-1' },
        { issueKey: 'BUG-7', commentIds: ['101', '102', 'invalid'] },
        { issueKey: 'BATTLE-1' }
      ],
      filterScope: 'self_ai_prefix'
    }));

    expect(intent).toMatchObject({
      kind: 'jira_delete_comment',
      filterScope: 'self_ai_prefix',
      targets: [
        expect.objectContaining({ issueKey: 'BATTLE-1', commentIds: [] }),
        expect.objectContaining({ issueKey: 'BUG-7', commentIds: ['101', '102'] })
      ]
    });
  });

  it('defaults jira_delete_comment filterScope to self_ai_prefix', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_delete_comment',
      targets: [{ issueKey: 'BUG-1' }]
    }));
    expect(intent.filterScope).toBe('self_ai_prefix');
  });

  it('rejects jira_delete_comment intents with illegal issue keys', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_delete_comment',
      targets: [{ issueKey: 'bug-1' }]
    }))).toThrow();
  });

  it('rejects jira_delete_comment intents without targets', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_delete_comment'
    }))).toThrow();
  });

  it('parses Jira bulk add comment intent with entries and per-issue bodies', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bulk_add_comment',
      reply: '已挨个起草评论。',
      entries: [
        { issueKey: 'BUG-1', body: '专属于 BUG-1 的分析。', sources: [{ type: 'file', path: 'src/foo.js' }] },
        { issueKey: 'BUG-2', body: '专属于 BUG-2 的分析。' },
        { issueKey: 'BUG-1', body: '应该被去重，不应该出现。' }
      ]
    }));

    expect(intent).toMatchObject({
      kind: 'jira_bulk_add_comment',
      entries: [
        expect.objectContaining({ issueKey: 'BUG-1', body: '专属于 BUG-1 的分析。', sources: [expect.objectContaining({ type: 'file', ref: 'src/foo.js' })] }),
        expect.objectContaining({ issueKey: 'BUG-2', body: '专属于 BUG-2 的分析。', sources: [] })
      ]
    });
    expect(intent.entries).toHaveLength(2);
  });

  it('still accepts legacy issueKeys + body shape and expands to entries', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bulk_add_comment',
      issueKeys: ['BUG-1', 'BUG-2'],
      body: '同一段评论。'
    }));

    expect(intent.entries).toEqual([
      expect.objectContaining({ issueKey: 'BUG-1', body: '同一段评论。' }),
      expect.objectContaining({ issueKey: 'BUG-2', body: '同一段评论。' })
    ]);
  });

  it('rejects Jira bulk add comment intents with illegal issue key', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bulk_add_comment',
      entries: [{ issueKey: 'bug-1', body: 'x' }, { issueKey: 'BUG-2', body: 'y' }]
    }))).toThrow();
  });

  it('rejects Jira bulk add comment intents without entries', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bulk_add_comment',
      entries: []
    }))).toThrow();
  });

  it('rejects Jira bulk add comment entries missing body', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_bulk_add_comment',
      entries: [{ issueKey: 'BUG-1' }]
    }))).toThrow();
  });

  it('parses Jira summarize-then-comment intent JSON with sources', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_summarize_then_comment',
      reply: '已根据分析生成评论。',
      issueKey: 'BUG-203',
      body: '【进展】关卡相机异常已定位为 TimeLine 顺序问题，临时回滚到 v0.8，下个版本前发补丁。',
      sources: [
        { type: 'file', path: 'src/services/jira-search-service.js' },
        { type: 'jira', key: 'BUG-99', label: '相邻单' },
        { type: 'note', label: '复述用户原话' }
      ]
    }));

    expect(intent).toMatchObject({
      kind: 'jira_summarize_then_comment',
      issueKey: 'BUG-203',
      body: expect.stringContaining('关卡相机异常'),
      sources: [
        expect.objectContaining({ type: 'file', ref: 'src/services/jira-search-service.js' }),
        expect.objectContaining({ type: 'jira', ref: 'BUG-99' }),
        expect.objectContaining({ type: 'note' })
      ]
    });
  });

  it('rejects Jira summarize-then-comment intents with illegal issue key', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_summarize_then_comment',
      issueKey: 'bug-1',
      body: 'x'
    }))).toThrow();
  });

  it('rejects Jira summarize-then-comment intents with overly long body', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_summarize_then_comment',
      issueKey: 'BUG-1',
      body: 'x'.repeat(8001)
    }))).toThrow();
  });

  it('parses Jira add comment intent JSON', () => {
    const intent = parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_add_comment',
      reply: '已直接写入评论。',
      issueKey: 'BUG-123',
      body: '测试通过，等待发布。'
    }));

    expect(intent).toEqual({
      kind: 'jira_add_comment',
      reply: '已直接写入评论。',
      issueKey: 'BUG-123',
      body: '测试通过，等待发布。'
    });
  });

  it('rejects Jira add comment intents with illegal issue key', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_add_comment',
      issueKey: 'bug-123',
      body: 'x'
    }))).toThrow();
  });

  it('rejects Jira add comment intents missing body', () => {
    expect(() => parseClaudeCodeOperationIntent(JSON.stringify({
      kind: 'jira_add_comment',
      issueKey: 'BUG-123'
    }))).toThrow();
  });

  it('builds Jira search error recovery prompts with whitelisted actions', () => {
    const prompt = buildClaudeCodeJiraSearchErrorAnalysisPrompt({
      message: { text: '查询曾浩然的 BUG 单' },
      searchFailure: {
        query: { projectKey: 'BUG', assignee: '曾浩然', status: '未开始' },
        jql: 'project = "BUG" AND assignee = "zenghaoran" AND status = "未开始"',
        error: { code: 'JIRA_API_ERROR', message: '"status"字段中没有"未开始"值。' },
        classification: { type: 'invalid_value' },
        attempt: 1,
        maxAttempts: 3
      }
    });

    expect(prompt).toContain('Jira 搜索失败');
    expect(prompt).toContain('retry_with_rewritten_jql');
    expect(prompt).toContain('ask_user_for_search_input');
    expect(prompt).toContain('not_recoverable');
    expect(prompt).toContain('字段中没有');
    expect(prompt).toContain('未开始');
    expect(prompt).not.toContain('Authorization:');
    expect(prompt).not.toContain('apiToken');
  });

  it('parses Jira search recovery JSON with retry rewritten JQL', () => {
    const recovery = parseClaudeCodeJiraSearchRecovery(JSON.stringify({
      kind: 'jira_search_recovery',
      plugin: 'jira',
      status: 'retry_available',
      summary: '移除不支持的 labels 字段后重试。',
      reason: '当前 Jira 不支持 labels 字段。',
      action: { id: 'retry_with_rewritten_jql', label: '使用修正后的 JQL 重试', requiresConfirmation: false },
      retry: { jql: 'project = "BUG" AND status = "处理中" ORDER BY updated DESC' }
    }));

    expect(recovery).toMatchObject({
      status: 'retry_available',
      analyzedBy: 'claude_code',
      action: { id: 'retry_with_rewritten_jql', requiresConfirmation: false },
      retry: { jql: 'project = "BUG" AND status = "处理中" ORDER BY updated DESC' }
    });
  });

  it('parses Jira search recovery JSON that needs user input', () => {
    const recovery = parseClaudeCodeJiraSearchRecovery(JSON.stringify({
      kind: 'jira_search_recovery',
      plugin: 'jira',
      status: 'needs_user_input',
      action: { id: 'ask_user_for_search_input', label: '请求用户补充状态', requiresConfirmation: false },
      supplement: { prompt: '请选择 Jira 状态', inputs: [{ id: 'status', type: 'select', label: 'Jira 状态', required: true, options: ['待处理', '进行中'] }] }
    }));

    expect(recovery.status).toBe('needs_user_input');
    expect(recovery.supplement.inputs[0]).toMatchObject({ id: 'status', type: 'select', options: ['待处理', '进行中'] });
  });

  it('rejects Jira search recovery actions outside the whitelist', () => {
    expect(() => parseClaudeCodeJiraSearchRecovery(JSON.stringify({
      kind: 'jira_search_recovery',
      plugin: 'jira',
      status: 'retry_available',
      action: { id: 'execute_arbitrary_request' },
      retry: { jql: 'project = "BUG"' }
    }))).toThrow();
  });

  it('rejects Jira search recovery retry_available without rewritten JQL', () => {
    expect(() => parseClaudeCodeJiraSearchRecovery(JSON.stringify({
      kind: 'jira_search_recovery',
      plugin: 'jira',
      status: 'retry_available',
      action: { id: 'retry_with_rewritten_jql' }
    }))).toThrow();
  });
});
