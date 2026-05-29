function timestamp(now = new Date()) {
  return now.toISOString();
}

function formatShallowMemoryEntry({ content, source = 'manual', now }) {
  return `\n## ${timestamp(now)}\n\n- 来源：${source}\n- 内容：${content}\n`;
}

function formatDeepIndexRow({ title, path, tags = [], summary, now }) {
  const tagText = Array.isArray(tags) ? tags.join(', ') : '';
  return `| ${title} | ${path} | ${tagText} | ${summary} | ${timestamp(now)} |\n`;
}

function formatLogicAssertionEntry({ statement, source = 'manual', now }) {
  return `\n## ${timestamp(now)}\n\n- 来源：${source}\n- 断言：${statement}\n`;
}

function formatLogicDraftEntry({ category, statement, source = 'passive_detected', now }) {
  return `\n## ${timestamp(now)}\n\n- 分类：${category}\n- 来源：${source}\n- 待确认断言：${statement}\n`;
}

module.exports = {
  formatShallowMemoryEntry,
  formatDeepIndexRow,
  formatLogicAssertionEntry,
  formatLogicDraftEntry
};
