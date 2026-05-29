const path = require('path');
const fs = require('fs/promises');
const { createTestRoot } = require('./helpers/test-root');
const { listAiCreatedIssueKeys, isAiCreatedIssue, classifyIssueKeys } = require('../src/services/jira-origin-service');
const { auditJiraOperation } = require('../src/services/jira-audit-service');

async function writeIndex(baizeRoot, operations) {
  const dir = path.join(baizeRoot, 'runtime', 'jira-operations');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ operations }), 'utf8');
}

describe('Jira origin service', () => {
  it('lists only AI-created issue keys recorded by the server', async () => {
    const { baizeRoot } = await createTestRoot();
    await writeIndex(baizeRoot, [
      { status: 'created', createdIssues: [{ key: 'BATTLE-1' }, { key: 'BATTLE-2' }] },
      { status: 'rejected', createdIssues: [{ key: 'BATTLE-3' }] },
      { status: 'created', createdIssues: [{ key: 'badkey' }, { key: 'BATTLE-4' }] }
    ]);

    const set = await listAiCreatedIssueKeys({ baizeRoot });
    expect(Array.from(set).sort()).toEqual(['BATTLE-1', 'BATTLE-2', 'BATTLE-4']);
    expect(await isAiCreatedIssue('BATTLE-2', { baizeRoot })).toBe(true);
    expect(await isAiCreatedIssue('BATTLE-3', { baizeRoot })).toBe(false);
    expect(await classifyIssueKeys(['BATTLE-1', 'BATTLE-3'], { baizeRoot })).toEqual([
      { issueKey: 'BATTLE-1', aiCreated: true },
      { issueKey: 'BATTLE-3', aiCreated: false }
    ]);
  });
});

describe('Jira audit service', () => {
  async function setupAi(baizeRoot, keys) {
    await writeIndex(baizeRoot, [{ status: 'created', createdIssues: keys.map((key) => ({ key })) }]);
  }

  it('requires confirmation when client deletes comments on AI-created issues', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, ['BATTLE-1']);
    const audit = await auditJiraOperation({ kind: 'jira_delete_comment', issueKeys: ['BATTLE-1'], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('require_confirmation');
    expect(audit.perIssue[0]).toMatchObject({ issueKey: 'BATTLE-1', aiCreated: true, decision: 'require_confirmation' });
  });

  it('allows scheduled deletes on AI-created issues without confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, ['BATTLE-1']);
    const audit = await auditJiraOperation({ kind: 'jira_delete_comment', issueKeys: ['BATTLE-1'], triggerSource: 'scheduled', baizeRoot });
    expect(audit.decision).toBe('allow');
  });

  it('requires confirmation when client deletes comments on non-AI issues', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_delete_comment', issueKeys: ['BUG-7'], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('require_confirmation');
    expect(audit.perIssue[0]).toMatchObject({ issueKey: 'BUG-7', aiCreated: false, decision: 'require_confirmation' });
  });

  it('denies non-comment write actions on non-AI issues', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_update_issue', issueKeys: ['BUG-7'], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('deny');
    expect(audit.perIssue[0]).toMatchObject({ decision: 'deny' });
  });

  it('allows scheduled comment deletes on non-AI issues without confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_add_comment', issueKeys: ['BUG-9'], triggerSource: 'scheduled', baizeRoot });
    expect(audit.decision).toBe('allow');
  });

  it('denies when issueKeys are missing for write actions', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_delete_comment', issueKeys: [], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('deny');
  });

  it('requires confirmation for jira_bulk_create even without issueKeys (client)', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_bulk_create', issueKeys: [], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('require_confirmation');
  });

  it('allows jira_bulk_create on scheduled triggers', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_bulk_create', issueKeys: [], triggerSource: 'scheduled', baizeRoot });
    expect(audit.decision).toBe('allow');
  });

  it('allows update_issue on AI-created issues with confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, ['BATTLE-1']);
    const audit = await auditJiraOperation({ kind: 'jira_update_issue', issueKeys: ['BATTLE-1'], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('require_confirmation');
  });

  it('denies update_issue on non-AI issues even with confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    await setupAi(baizeRoot, []);
    const audit = await auditJiraOperation({ kind: 'jira_update_issue', issueKeys: ['BUG-7'], triggerSource: 'client', baizeRoot });
    expect(audit.decision).toBe('deny');
  });
});
