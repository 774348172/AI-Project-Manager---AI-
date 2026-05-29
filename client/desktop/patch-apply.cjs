const fs = require('fs/promises');
const path = require('path');

const SECRET_PATH_PATTERN = /(^|[/\\])(\.env(?:\.|$)|[^/\\]*(secret|token|credential|apikey|api-key)[^/\\]*)/i;
const BLOCKED_PATH_SEGMENTS = new Set(['node_modules', 'dist', 'build', '.git']);

function patchError(message, code = 'PATCH_ERROR') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizePatchPath(value) {
  let filePath = typeof value === 'string' ? value.trim() : '';
  if (filePath.startsWith('a/') || filePath.startsWith('b/')) {
    filePath = filePath.slice(2);
  }
  if (!filePath || filePath === '/dev/null') {
    return null;
  }
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\\\')) {
    patchError('补丁不能包含绝对路径。', 'PATCH_PATH_OUTSIDE_WORKSPACE');
  }
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    patchError('补丁路径不能跳出本地工作区。', 'PATCH_PATH_OUTSIDE_WORKSPACE');
  }
  if (normalized.split('/').some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    patchError('补丁不能修改依赖目录、构建产物或 Git 内部文件。', 'PATCH_BLOCKED_PATH');
  }
  if (SECRET_PATH_PATTERN.test(normalized)) {
    patchError('补丁不能修改密钥或敏感配置文件。', 'PATCH_SECRET_PATH');
  }
  return normalized;
}

function resolveInsideWorkspace(workspaceRoot, relativePath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    patchError('补丁路径不能跳出本地工作区。', 'PATCH_PATH_OUTSIDE_WORKSPACE');
  }
  return target;
}

function parsePatch(patchText) {
  const lines = String(patchText || '').split(/\r?\n/);
  const files = [];
  let current = null;
  let currentHunk = null;

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
    if (diffMatch) {
      current = { path: normalizePatchPath(diffMatch[2]), changeType: 'modify', additions: 0, deletions: 0, hunks: [] };
      if (current.path) {
        files.push(current);
      }
      currentHunk = null;
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('new file mode ')) {
      current.changeType = 'create';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.changeType = 'delete';
      continue;
    }
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      currentHunk = { oldStart: Number(hunkMatch[1]), lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions += 1;
      currentHunk.lines.push({ type: 'add', text: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions += 1;
      currentHunk.lines.push({ type: 'remove', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: 'context', text: line.slice(1) });
    } else if (line === '\\ No newline at end of file') {
      continue;
    }
  }

  if (files.length === 0) {
    patchError('补丁格式无效。', 'PATCH_INVALID');
  }
  return files;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function splitPatchText(text) {
  if (text === '') {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n') || text.endsWith('\r\n')) {
    lines.pop();
  }
  return lines;
}

function applyFilePatch(originalText, filePatch) {
  const originalLines = splitPatchText(originalText);
  const output = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    const hunkStart = Math.max(0, hunk.oldStart - 1);
    while (cursor < hunkStart) {
      output.push(originalLines[cursor]);
      cursor += 1;
    }

    for (const hunkLine of hunk.lines) {
      if (hunkLine.type === 'context') {
        if (originalLines[cursor] !== hunkLine.text) {
          patchError(`补丁上下文不匹配：${filePatch.path}`, 'PATCH_CONTEXT_MISMATCH');
        }
        output.push(originalLines[cursor]);
        cursor += 1;
      } else if (hunkLine.type === 'remove') {
        if (originalLines[cursor] !== hunkLine.text) {
          patchError(`补丁上下文不匹配：${filePatch.path}`, 'PATCH_CONTEXT_MISMATCH');
        }
        cursor += 1;
      } else if (hunkLine.type === 'add') {
        output.push(hunkLine.text);
      }
    }
  }

  while (cursor < originalLines.length) {
    output.push(originalLines[cursor]);
    cursor += 1;
  }
  return `${output.join('\n')}\n`;
}

async function previewPatch({ workspaceRoot, patch }) {
  const files = parsePatch(patch).map((filePatch) => ({
    path: filePatch.path,
    changeType: filePatch.changeType,
    additions: filePatch.additions,
    deletions: filePatch.deletions,
    targetPath: resolveInsideWorkspace(workspaceRoot, filePatch.path),
    canApply: true,
    warning: null
  }));
  return { ok: true, files, warnings: [] };
}

async function applyPatch({ workspaceRoot, patch }) {
  const files = parsePatch(patch);
  const writes = [];
  for (const filePatch of files) {
    const targetPath = resolveInsideWorkspace(workspaceRoot, filePatch.path);
    const originalText = await readTextIfExists(targetPath);
    writes.push({ filePath: targetPath, content: applyFilePatch(originalText, filePatch), relativePath: filePatch.path });
  }

  for (const write of writes) {
    await fs.mkdir(path.dirname(write.filePath), { recursive: true });
    await fs.writeFile(write.filePath, write.content, 'utf8');
  }

  return { ok: true, appliedFiles: writes.map((write) => write.relativePath) };
}

module.exports = {
  normalizePatchPath,
  parsePatch,
  previewPatch,
  applyPatch
};
