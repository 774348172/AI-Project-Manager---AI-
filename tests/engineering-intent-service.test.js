const { classifyEngineeringIntent, shouldUseClaudeCode } = require('../src/services/engineering-intent-service');

describe('engineering intent service', () => {
  it('routes readonly engineering questions to Claude Code', () => {
    const intent = classifyEngineeringIntent({ text: '请帮我看看聊天流式接口是怎么实现的' });

    expect(intent).toMatchObject({
      route: 'engineering_readonly',
      requiresConfirmation: false
    });
  });

  it('requires confirmation for write and test requests', () => {
    expect(classifyEngineeringIntent({ text: '帮我修复聊天接口 bug' })).toMatchObject({
      route: 'engineering_write',
      requiresConfirmation: true
    });
    expect(classifyEngineeringIntent({ text: '运行 npm test' })).toMatchObject({
      route: 'engineering_test',
      requiresConfirmation: true
    });
  });

  it('marks dangerous requests as dangerous', () => {
    expect(classifyEngineeringIntent({ text: '执行 git reset --hard' })).toMatchObject({
      route: 'dangerous',
      requiresConfirmation: true
    });
  });

  it('does not use Claude Code unless enabled', () => {
    const intent = classifyEngineeringIntent({ text: '分析一下服务端路由代码' });

    expect(shouldUseClaudeCode(intent, {
      enabled: false,
      routing: { autoDetectEngineeringTasks: true }
    })).toBe(false);
    expect(shouldUseClaudeCode(intent, {
      enabled: true,
      routing: { autoDetectEngineeringTasks: true }
    })).toBe(true);
  });
});
