const DANGEROUS_PATTERNS = [
  /\b(rm\s+-rf|reset\s+--hard|clean\s+-f|push\s+--force|force\s+push)\b/i,
  /(删除|清空|销毁).*(全部|所有|整个)/,
  /(读取|查看|打开).*(\.env|密钥|secret|token|api\s*key|apikey)/i
];

const WRITE_PATTERNS = [
  /(修改|改一下|更改|实现|新增|添加|接入|重构|修复|补齐|优化|删除|移除).*(代码|文件|接口|路由|服务|客户端|服务端|UI|样式|测试|配置)?/,
  /(帮我|请).*(改|修|实现|新增|添加|删除|移除|重构)/
];

const TEST_PATTERNS = [
  /(运行|执行|跑).*(测试|test|构建|打包|build|pack|dist)/i,
  /\b(npm\s+test|npm\s+run\s+(build|pack|dist|desktop))/i
];

const READONLY_ENGINEERING_PATTERNS = [
  /(看一下|看看|检查|分析|解释|定位|排查|查一下|阅读|梳理).*(代码|项目|工程|接口|路由|服务|文件|测试|UI|客户端|服务端|报错|bug|问题)/i,
  /(怎么实现|在哪里|哪个文件|调用链|架构|结构|逻辑).*(代码|项目|工程|接口|路由|服务|客户端|服务端)?/i,
  /\b(stack trace|error|bug|api|route|server|client|electron|express|vitest)\b/i
];

const AMBIGUOUS_ENGINEERING_PATTERNS = [
  /(处理|弄一下|搞一下|优化一下).*(问题|代码|项目|工程|接口|客户端|服务端)?/,
  /(有问题|不好用|不对劲)$/
];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyEngineeringIntent({ text } = {}) {
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  if (!normalizedText) {
    return {
      route: 'ordinary_chat',
      reason: 'empty_text',
      requiresConfirmation: false
    };
  }

  if (matchesAny(normalizedText, DANGEROUS_PATTERNS)) {
    return {
      route: 'dangerous',
      reason: 'dangerous_operation',
      requiresConfirmation: true
    };
  }

  if (matchesAny(normalizedText, TEST_PATTERNS)) {
    return {
      route: 'engineering_test',
      reason: 'test_or_build_request',
      requiresConfirmation: true
    };
  }

  if (/(怎么实现|在哪里|哪个文件|调用链|架构|结构|逻辑)/.test(normalizedText)) {
    return {
      route: 'engineering_readonly',
      reason: 'readonly_engineering_question',
      requiresConfirmation: false
    };
  }

  if (matchesAny(normalizedText, WRITE_PATTERNS)) {
    return {
      route: 'engineering_write',
      reason: 'write_request',
      requiresConfirmation: true
    };
  }

  if (matchesAny(normalizedText, READONLY_ENGINEERING_PATTERNS)) {
    return {
      route: 'engineering_readonly',
      reason: 'readonly_engineering_request',
      requiresConfirmation: false
    };
  }

  if (matchesAny(normalizedText, AMBIGUOUS_ENGINEERING_PATTERNS)) {
    return {
      route: 'ambiguous',
      reason: 'ambiguous_engineering_request',
      requiresConfirmation: false
    };
  }

  return {
    route: 'ordinary_chat',
    reason: 'ordinary_chat',
    requiresConfirmation: false
  };
}

function shouldUseClaudeCode(intent, config) {
  return Boolean(
    config &&
    config.enabled === true &&
    config.routing &&
    config.routing.autoDetectEngineeringTasks === true &&
    intent &&
    intent.route === 'engineering_readonly'
  );
}

module.exports = {
  classifyEngineeringIntent,
  shouldUseClaudeCode
};
