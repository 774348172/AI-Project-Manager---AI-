const fs = require('fs/promises');
const { getJiraConfig } = require('./config-service');
const { jiraError } = require('./jira-client-service');
const { getAttachment } = require('./attachment-service');

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (readString(value)) {
      return readString(value);
    }
  }
  return null;
}

function parseLabels(value) {
  const text = readString(value);
  if (!text) {
    return [];
  }
  return text.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeDraft(row = {}, config = {}) {
  const summary = pick(row, ['summary', '标题', '需求标题', '名称', 'title']);
  if (!summary) {
    return null;
  }
  return {
    summary,
    description: pick(row, ['description', '描述', '需求描述', '内容', 'body']) || '',
    projectKey: pick(row, ['projectKey', 'project', '项目', '项目Key']) || config.defaultProjectKey,
    issueType: pick(row, ['issueType', 'type', '类型', '需求类型']) || config.defaultIssueType || 'Task',
    assignee: pick(row, ['assignee', '经办人', '负责人', '处理人']),
    priority: pick(row, ['priority', '优先级']),
    labels: Array.isArray(row.labels) ? row.labels.map(readString).filter(Boolean) : parseLabels(pick(row, ['labels', '标签']))
  };
}

function parseFieldLine(line) {
  const match = line.match(/^[\s\-*•]*([A-Za-z]+|[一-龥]+(?:[A-Za-z]+)?)\s*[:：]\s*(.+)$/);
  if (!match) {
    return null;
  }
  const keyMap = {
    summary: 'summary',
    title: 'summary',
    标题: 'summary',
    需求标题: 'summary',
    名称: 'summary',
    description: 'description',
    描述: 'description',
    需求描述: 'description',
    内容: 'description',
    project: 'projectKey',
    projectKey: 'projectKey',
    项目: 'projectKey',
    项目Key: 'projectKey',
    issueType: 'issueType',
    type: 'issueType',
    类型: 'issueType',
    需求类型: 'issueType',
    assignee: 'assignee',
    经办人: 'assignee',
    负责人: 'assignee',
    处理人: 'assignee',
    labels: 'labels',
    标签: 'labels',
    priority: 'priority',
    优先级: 'priority'
  };
  const key = keyMap[match[1]];
  return key ? { key, value: match[2].trim() } : null;
}

function parseStructuredTextRows(lines) {
  const rows = [];
  let current = null;
  let matched = false;
  for (const line of lines) {
    const field = parseFieldLine(line);
    if (!field) {
      continue;
    }
    matched = true;
    if (!current || (field.key === 'summary' && current.summary)) {
      if (current) {
        rows.push(current);
      }
      current = {};
    }
    current[field.key] = field.value;
  }
  if (current) {
    rows.push(current);
  }
  if (!matched) {
    return [];
  }
  return rows.map((row) => ({
    ...row,
    summary: row.summary || row.description
  })).filter((row) => row.summary);
}

function readNaturalField(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && readString(match[1])) {
      return readString(match[1]);
    }
  }
  return null;
}

function parseNaturalTextRow(line) {
  if (!/jira/i.test(line) || !/(创建|新建|需求单|任务|issue|单子)/i.test(line)) {
    return null;
  }
  const projectKey = readNaturalField(line, [
    /项目\s*(?:的)?\s*(?:key|Key|KEY)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]*)/,
    /project\s*(?:key)?\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]*)/i
  ]);
  const summary = readNaturalField(line, [
    /(?:单子名字|需求单名字|任务名字|标题|名称|summary)\s*(?:就叫做|叫做|为|是|[:：])\s*([^，,。；;\n]+?)(?=\s+项目|\s+project|$)/i,
    /(?:创建|新建).*?(?:jira|Jira).*?(?:需求单|任务|issue|单子).*?(?:叫做|为|是)\s*([^，,。；;\n]+?)(?=\s+项目|\s+project|$)/i
  ]) || line.replace(/项目\s*(?:的)?\s*(?:key|Key|KEY)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]*/g, '').trim();
  const assignee = readNaturalField(line, [
    /给\s*([一-龥A-Za-z0-9_.-]+)\s*(?:创建|新建)/,
    /(?:负责人|经办人|处理人|任务负责人)\s*(?:是|为|:|：)?\s*([一-龥A-Za-z0-9_.-]+)/
  ]);
  return {
    summary,
    projectKey,
    assignee
  };
}

function parseTextRows(text) {
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const structuredRows = parseStructuredTextRows(lines);
  if (structuredRows.length > 0) {
    return structuredRows;
  }
  if (lines.some((line) => /[|\t]/.test(line))) {
    return lines.map((line) => {
      const parts = line.split(/[|\t]/).map((part) => part.trim());
      return {
        summary: parts[0],
        description: parts.slice(1).join('\n')
      };
    });
  }
  const naturalRows = lines.map(parseNaturalTextRow).filter(Boolean);
  if (naturalRows.length > 0) {
    return naturalRows;
  }
  return lines.map((line) => ({
    summary: line,
    description: ''
  }));
}

async function decodeContent(input = {}, options = {}) {
  const attachmentId = readString(input.attachmentId);
  if (attachmentId) {
    const attachment = await getAttachment(attachmentId, options);
    return {
      fileName: attachment.fileName,
      buffer: await fs.readFile(attachment.storagePath)
    };
  }
  if (Buffer.isBuffer(input.buffer)) {
    return { fileName: readString(input.fileName) || 'jira-import.txt', buffer: input.buffer };
  }
  if (readString(input.contentBase64)) {
    return { fileName: readString(input.fileName) || 'jira-import.txt', buffer: Buffer.from(input.contentBase64, 'base64') };
  }
  if (readString(input.text)) {
    return { fileName: readString(input.fileName) || 'jira-import.txt', buffer: Buffer.from(input.text, 'utf8') };
  }
  throw jiraError('请提供 xlsx 或文本内容。');
}

async function createJiraImportDrafts(input = {}, options = {}) {
  const config = await getJiraConfig(options);
  let fileName;
  let rows;
  if (Array.isArray(input.drafts)) {
    fileName = readString(input.fileName) || 'jira-import.json';
    rows = input.drafts;
  } else {
    const decoded = await decodeContent(input, options);
    fileName = decoded.fileName;
    const lowerName = fileName.toLowerCase();
    if (/\.xlsx?$/i.test(lowerName)) {
      throw jiraError('xlsx 文件需要先交由 Claude 读取解析后再生成 Jira 草稿。');
    }
    rows = parseTextRows(decoded.buffer.toString('utf8'));
  }
  const drafts = rows.map((row) => normalizeDraft(row, config)).filter(Boolean);
  if (drafts.length === 0) {
    throw jiraError('没有从文件中解析到可创建的 Jira 需求单。');
  }
  return {
    fileName,
    count: drafts.length,
    drafts,
    warnings: drafts.some((draft) => !draft.projectKey)
      ? ['存在未配置项目 Key 的草稿，确认创建前需要补充项目。']
      : []
  };
}

function isWritableCustomField(fieldId) {
  return /^customfield_\d+$/.test(readString(fieldId) || '');
}

function draftToJiraFields(draft = {}, config = {}) {
  if (!draft.projectKey) {
    throw jiraError('Jira 项目 Key 不能为空。');
  }
  const fields = {
    project: { key: draft.projectKey },
    summary: draft.summary,
    description: draft.description || '',
    issuetype: draft.issueTypeId ? { id: draft.issueTypeId } : { name: draft.issueType || config.defaultIssueType || 'Task' }
  };
  const assigneeValue = draft.assigneeName || draft.assigneeAccountId || draft.assignee;
  if (draft.assigneeAccountId || draft.assigneeName || draft.assignee) {
    fields.assignee = config.deploymentType === 'cloud'
      ? { accountId: draft.assigneeAccountId || draft.assignee }
      : { name: draft.assigneeName || draft.assignee };
  }
  const taskOwnerField = config.fieldMappings && (config.fieldMappings.taskOwner || config.fieldMappings.assignee || config.fieldMappings.任务负责人);
  if (isWritableCustomField(taskOwnerField) && assigneeValue) {
    fields[taskOwnerField] = assigneeValue;
  }
  if (draft.priority) {
    fields.priority = { name: draft.priority };
  }
  if (Array.isArray(draft.labels) && draft.labels.length > 0) {
    fields.labels = draft.labels;
  }
  return fields;
}

module.exports = {
  parseTextRows,
  normalizeDraft,
  createJiraImportDrafts,
  draftToJiraFields
};
