const { classifyIssueKeys } = require('../jira-origin-service');

const COMMENT_KINDS = new Set([
  'jira_add_comment',
  'jira_bulk_add_comment',
  'jira_summarize_then_comment',
  'jira_delete_comment',
  'jira_list_comments'
]);

const ISSUE_WRITE_KINDS = new Set([
  'jira_bulk_create',
  'jira_update_issue',
  'jira_transition_issue',
  'jira_delete_issue'
]);

const READ_KINDS = new Set([
  'jira_search',
  'jira_list_comments'
]);

function decideForIssue({ kind, aiCreated, triggerSource }) {
  if (READ_KINDS.has(kind)) {
    return { decision: 'allow', reason: '只读操作，无需确认。' };
  }
  const isCommentOp = COMMENT_KINDS.has(kind);
  const isIssueWriteOp = ISSUE_WRITE_KINDS.has(kind);
  if (!isCommentOp && !isIssueWriteOp) {
    return { decision: 'deny', reason: `不支持的操作类型：${kind}。` };
  }
  if (aiCreated) {
    if (triggerSource === 'scheduled') {
      return { decision: 'allow', reason: 'AI 创建 + 定时任务，免确认。' };
    }
    return { decision: 'require_confirmation', reason: 'AI 创建的单子，客户端确认后即可执行。' };
  }
  if (isCommentOp) {
    if (triggerSource === 'scheduled') {
      return { decision: 'allow', reason: '非 AI 单评论增删，定时任务免确认。' };
    }
    return { decision: 'require_confirmation', reason: '非 AI 单只能修改评论，客户端确认后执行。' };
  }
  return { decision: 'deny', reason: '非 AI 单不能修改评论以外的字段。' };
}

function summarizeDecisions(perIssue, kind, triggerSource) {
  const allowedKeys = perIssue.filter((item) => item.decision === 'allow').map((item) => item.issueKey);
  const confirmKeys = perIssue.filter((item) => item.decision === 'require_confirmation').map((item) => item.issueKey);
  const denyKeys = perIssue.filter((item) => item.decision === 'deny').map((item) => item.issueKey);

  if (denyKeys.length > 0 && allowedKeys.length === 0 && confirmKeys.length === 0) {
    return {
      decision: 'deny',
      summary: `白泽：审计官拒绝执行 ${kind}：${denyKeys.length} 个单不允许这种操作。`
    };
  }
  if (confirmKeys.length > 0) {
    return {
      decision: 'require_confirmation',
      summary: `白泽：${kind} 涉及 ${perIssue.length} 个 Jira 单，请确认后再执行。` + (denyKeys.length > 0 ? `（其中 ${denyKeys.length} 个会被审计官跳过：${denyKeys.join('、')}）` : '')
    };
  }
  if (allowedKeys.length === perIssue.length && triggerSource === 'scheduled') {
    return {
      decision: 'allow',
      summary: `白泽：定时任务，${kind} 已被审计官放行。`
    };
  }
  return {
    decision: 'allow',
    summary: `白泽：${kind} 已被审计官放行。`
  };
}

async function audit({ kind, issueKeys = [], triggerSource = 'client', baizeRoot } = {}) {
  if (typeof kind !== 'string' || !kind) {
    return {
      decision: 'deny',
      summary: '白泽：审计官无法识别空操作。',
      perIssue: []
    };
  }
  if (READ_KINDS.has(kind)) {
    return {
      decision: 'allow',
      summary: `白泽：${kind} 是只读操作，审计官放行。`,
      perIssue: (issueKeys || []).map((key) => ({ issueKey: key, aiCreated: false, decision: 'allow', reason: '只读操作。' }))
    };
  }
  if (kind === 'jira_bulk_create') {
    if (triggerSource === 'scheduled') {
      return {
        decision: 'allow',
        summary: '白泽：定时任务创建 Jira 单，审计官放行。',
        perIssue: []
      };
    }
    return {
      decision: 'require_confirmation',
      summary: '白泽：创建 Jira 单需要在客户端审计卡上确认。',
      perIssue: []
    };
  }
  const normalizedKeys = Array.from(new Set((issueKeys || []).map((key) => String(key || '').trim()).filter(Boolean)));
  if (normalizedKeys.length === 0) {
    return {
      decision: 'deny',
      summary: '白泽：审计官需要明确的 Jira 单号才能放行写动作。',
      perIssue: []
    };
  }
  const classification = await classifyIssueKeys(normalizedKeys, { baizeRoot });
  const perIssue = classification.map(({ issueKey, aiCreated }) => {
    const { decision, reason } = decideForIssue({ kind, aiCreated, triggerSource });
    return { issueKey, aiCreated, decision, reason };
  });
  const { decision, summary } = summarizeDecisions(perIssue, kind, triggerSource);
  return { decision, summary, perIssue };
}

module.exports = {
  audit,
  COMMENT_KINDS,
  ISSUE_WRITE_KINDS,
  READ_KINDS
};
