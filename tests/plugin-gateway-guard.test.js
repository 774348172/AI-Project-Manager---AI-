const fs = require('fs');
const path = require('path');

function readAllJs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readAllJs(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Plugin gateway guard', () => {
  it('logic officer assertion baize/logic/assertions/plugin-gateway.md exists', () => {
    const file = path.join(__dirname, '..', 'baize', 'logic', 'assertions', 'plugin-gateway.md');
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('plugin-gateway-service');
    expect(content).toContain('审计官');
  });

  it('plugin write APIs are not called from chat-service except inside gateway-driven executors', () => {
    const chatService = path.join(__dirname, '..', 'src', 'services', 'baize-chat-service.js');
    const content = fs.readFileSync(chatService, 'utf8');
    const lines = content.split(/\r?\n/);
    const forbidden = ['addJiraComment(', 'deleteJiraComment(', 'deleteJiraAuthorComments(', 'createJiraIssue('];
    const offenders = [];
    let inExecutor = false;
    let executorDepth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^async function execute[A-Z]/.test(line)) {
        inExecutor = true;
        executorDepth = 0;
      }
      if (inExecutor) {
        executorDepth += (line.match(/\{/g) || []).length;
        executorDepth -= (line.match(/\}/g) || []).length;
        if (executorDepth <= 0 && /\}/.test(line)) {
          inExecutor = false;
        }
        continue;
      }
      for (const symbol of forbidden) {
        if (line.includes(symbol) && !line.trim().startsWith('//') && !line.includes('require(')) {
          offenders.push(`${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
