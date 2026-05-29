const path = require('path');

const DEFAULT_MAX_PATCH_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_CHANGES = 2000;
const SECRET_PATH_PATTERN = /(^|[/\\])(\.env(?:\.|$)|[^/\\]*(secret|token|credential|apikey|api-key)[^/\\]*)/i;
const BLOCKED_PATH_SEGMENTS = new Set(['node_modules', 'dist', 'build', '.git']);

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function normalizePatchPath(value) {
  if (typeof value !== 'string') {
    throw validationError('补丁路径无效。');
  }

  let filePath = value.trim();
  if (filePath.startsWith('a/') || filePath.startsWith('b/')) {
    filePath = filePath.slice(2);
  }
  if (!filePath || filePath === '/dev/null') {
    return null;
  }
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\\\')) {
    throw validationError('补丁不能包含绝对路径。');
  }

  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw validationError('补丁路径不能跳出工作区。');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    throw validationError('补丁不能修改构建产物、依赖目录或 Git 内部文件。');
  }
  if (SECRET_PATH_PATTERN.test(normalized)) {
    throw validationError('补丁不能修改密钥或敏感配置文件。');
  }

  return normalized;
}

function parsePatchFiles(patchText, options = {}) {
  const text = typeof patchText === 'string' ? patchText : '';
  const maxPatchBytes = options.maxPatchBytes || DEFAULT_MAX_PATCH_BYTES;
  if (Buffer.byteLength(text, 'utf8') > maxPatchBytes) {
    throw validationError('补丁内容过大。');
  }
  if (/^GIT binary patch/m.test(text) || /^Binary files /m.test(text)) {
    throw validationError('暂不支持二进制补丁。');
  }

  const fileMap = new Map();
  let currentPath = null;
  let totalChanges = 0;

  for (const line of text.split(/\r?\n/)) {
    const diffMatch = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
    if (diffMatch) {
      const targetPath = normalizePatchPath(diffMatch[2]);
      currentPath = targetPath;
      if (targetPath && !fileMap.has(targetPath)) {
        fileMap.set(targetPath, { path: targetPath, changeType: 'modify', additions: 0, deletions: 0 });
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const targetPath = normalizePatchPath(line.slice(4).split('\t')[0]);
      if (targetPath) {
        currentPath = targetPath;
        if (!fileMap.has(targetPath)) {
          fileMap.set(targetPath, { path: targetPath, changeType: 'modify', additions: 0, deletions: 0 });
        }
      }
      continue;
    }

    if (line.startsWith('new file mode ') && currentPath && fileMap.has(currentPath)) {
      fileMap.get(currentPath).changeType = 'create';
      continue;
    }

    if (line.startsWith('deleted file mode ') && currentPath && fileMap.has(currentPath)) {
      fileMap.get(currentPath).changeType = 'delete';
      continue;
    }

    if (!currentPath || !fileMap.has(currentPath) || line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      fileMap.get(currentPath).additions += 1;
      totalChanges += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      fileMap.get(currentPath).deletions += 1;
      totalChanges += 1;
    }
  }

  const files = [...fileMap.values()];
  if (files.length === 0 && text.trim() !== '') {
    throw validationError('补丁格式无效。');
  }
  if (files.length > (options.maxFiles || DEFAULT_MAX_FILES)) {
    throw validationError('补丁修改文件过多。');
  }
  if (totalChanges > (options.maxChanges || DEFAULT_MAX_CHANGES)) {
    throw validationError('补丁修改行数过多。');
  }

  return files;
}

function validatePatch(patchText, options) {
  const files = parsePatchFiles(patchText, options);
  return {
    patch: patchText,
    files,
    warnings: []
  };
}

module.exports = {
  normalizePatchPath,
  parsePatchFiles,
  validatePatch
};
