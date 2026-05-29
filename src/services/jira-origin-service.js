const path = require('path');
const paths = require('../config/paths');
const { readJsonIfExists } = require('../lib/file-store');

function getIndexFile(baizeRoot = paths.BAIZE_ROOT) {
  return path.join(baizeRoot, 'runtime', 'jira-operations', 'index.json');
}

async function loadIndex(baizeRoot = paths.BAIZE_ROOT) {
  return readJsonIfExists(getIndexFile(baizeRoot), { operations: [] });
}

async function listAiCreatedIssueKeys({ baizeRoot } = {}) {
  const index = await loadIndex(baizeRoot);
  const keys = new Set();
  for (const op of index.operations || []) {
    if (op.status !== 'created') {
      continue;
    }
    const created = Array.isArray(op.createdIssues) ? op.createdIssues : [];
    for (const issue of created) {
      const key = issue && typeof issue.key === 'string' ? issue.key.trim() : null;
      if (key && /^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

async function isAiCreatedIssue(issueKey, { baizeRoot } = {}) {
  if (typeof issueKey !== 'string' || !issueKey) {
    return false;
  }
  const set = await listAiCreatedIssueKeys({ baizeRoot });
  return set.has(issueKey.trim());
}

async function classifyIssueKeys(issueKeys = [], { baizeRoot } = {}) {
  const set = await listAiCreatedIssueKeys({ baizeRoot });
  return issueKeys.map((key) => ({
    issueKey: key,
    aiCreated: set.has(String(key || '').trim())
  }));
}

module.exports = {
  listAiCreatedIssueKeys,
  isAiCreatedIssue,
  classifyIssueKeys
};
