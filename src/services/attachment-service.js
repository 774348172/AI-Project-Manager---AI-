const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { path7za } = require('7zip-bin');
const XLSX = require('xlsx');
const paths = require('../config/paths');
const { ensureInside, readJsonIfExists, writeJson, writeText } = require('../lib/file-store');
const { addShallowMemory, addDeepMemoryIndex } = require('./memory-service');
const { assertSafeId } = require('./conversation-service');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.js', '.cjs', '.mjs', '.html', '.css', '.yaml', '.yml', '.csv', '.log']);
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xls']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.zip']);
const ARCHIVE_MIME_TYPES = new Set([
  'application/x-7z-compressed',
  'application/zip',
  'application/x-zip-compressed'
]);
const MAX_ARCHIVE_FILES = 200;
const MAX_ARCHIVE_EXTRACTED_BYTES = 50 * 1024 * 1024;
const SPREADSHEET_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]);
const SPREADSHEET_SEMANTIC_EXTRACTOR_VERSION = 1;
const MAX_SEMANTIC_XLSX_SHEETS = 20;
const MAX_SEMANTIC_XLSX_ROWS_PER_SHEET = 1000;
const MAX_SEMANTIC_XLSX_COLUMNS_PER_SHEET = 80;
const MAX_SEMANTIC_XLSX_CHARS = 120000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const IMAGE_MIME_PATTERN = /^image\/(png|jpeg|gif|webp|svg\+xml)$/i;

function validationError(message, code = 'VALIDATION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function getAttachmentPaths(baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'uploads');
  return { root };
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(typeof fileName === 'string' ? fileName : '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return baseName || 'upload.bin';
}

function decodeBase64(contentBase64) {
  if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') {
    throw validationError('文件内容不能为空。');
  }
  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.length === 0) {
    throw validationError('文件内容不能为空。');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw validationError('文件不能超过 50MB。', 'UPLOAD_TOO_LARGE', 413);
  }
  return buffer;
}

function classifyAttachment({ fileName, mimeType, buffer }) {
  const extension = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension) || IMAGE_MIME_PATTERN.test(mimeType || '')) {
    return 'image';
  }
  if (SPREADSHEET_EXTENSIONS.has(extension) || SPREADSHEET_MIME_TYPES.has(String(mimeType || '').toLowerCase())) {
    return 'spreadsheet';
  }
  if (ARCHIVE_EXTENSIONS.has(extension) || ARCHIVE_MIME_TYPES.has(String(mimeType || '').toLowerCase())) {
    return 'archive';
  }
  if (TEXT_EXTENSIONS.has(extension) || String(mimeType || '').startsWith('text/')) {
    return 'text';
  }
  if (buffer.includes(0)) {
    return 'binary';
  }
  return 'text';
}

function extractSpreadsheetText(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return workbook.SheetNames.map((sheetName) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false }).trim();
    return csv ? `工作表：${sheetName}\n${csv}` : '';
  }).filter(Boolean).join('\n\n').slice(0, 12000);
}

function formatCellValue(cell) {
  if (!cell) {
    return '';
  }
  if (cell.w !== undefined && cell.w !== null && String(cell.w).trim() !== '') {
    return String(cell.w).trim();
  }
  if (cell.v !== undefined && cell.v !== null) {
    return String(cell.v).trim();
  }
  return '';
}

function pushBoundedLine(lines, line, state) {
  if (state.charCount >= state.charLimit) {
    state.truncated = true;
    return false;
  }
  const next = String(line || '');
  if (state.charCount + next.length + 1 > state.charLimit) {
    const remaining = Math.max(0, state.charLimit - state.charCount - 1);
    if (remaining > 0) {
      lines.push(next.slice(0, remaining));
      state.charCount += remaining + 1;
    }
    state.truncated = true;
    return false;
  }
  lines.push(next);
  state.charCount += next.length + 1;
  return true;
}

function formatMergeRange(range) {
  return `${XLSX.utils.encode_cell(range.s)}:${XLSX.utils.encode_cell(range.e)}`;
}

function extractSpreadsheetSemanticText(buffer, options = {}) {
  const limits = {
    sheetLimit: Number.isInteger(options.sheetLimit) ? options.sheetLimit : MAX_SEMANTIC_XLSX_SHEETS,
    rowLimit: Number.isInteger(options.rowLimit) ? options.rowLimit : MAX_SEMANTIC_XLSX_ROWS_PER_SHEET,
    columnLimit: Number.isInteger(options.columnLimit) ? options.columnLimit : MAX_SEMANTIC_XLSX_COLUMNS_PER_SHEET,
    charLimit: Number.isInteger(options.charLimit) ? options.charLimit : MAX_SEMANTIC_XLSX_CHARS
  };
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true, cellText: true, cellFormula: true, cellHTML: false });
  const lines = [];
  const state = { charCount: 0, charLimit: limits.charLimit, truncated: false };
  const sheetNames = workbook.SheetNames.slice(0, limits.sheetLimit);
  pushBoundedLine(lines, `工作簿 sheet 数：${workbook.SheetNames.length}`, state);
  if (workbook.SheetNames.length > sheetNames.length) {
    state.truncated = true;
    pushBoundedLine(lines, `仅包含前 ${sheetNames.length} 个 sheet。`, state);
  }

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const ref = sheet && sheet['!ref'];
    pushBoundedLine(lines, '', state);
    pushBoundedLine(lines, `工作表：${sheetName}`, state);
    pushBoundedLine(lines, `范围：${ref || '空'}`, state);
    if (!ref) {
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    const maxRow = Math.min(range.e.r, range.s.r + limits.rowLimit - 1);
    const maxColumn = Math.min(range.e.c, range.s.c + limits.columnLimit - 1);
    if (maxRow < range.e.r || maxColumn < range.e.c) {
      state.truncated = true;
      pushBoundedLine(lines, `截断：仅包含前 ${limits.rowLimit} 行、前 ${limits.columnLimit} 列。`, state);
    }
    const merges = Array.isArray(sheet['!merges']) ? sheet['!merges'] : [];
    if (merges.length > 0) {
      pushBoundedLine(lines, `合并单元格：${merges.slice(0, 50).map(formatMergeRange).join(', ')}${merges.length > 50 ? ' ...' : ''}`, state);
    }
    const headerValues = [];
    for (let column = range.s.c; column <= maxColumn; column += 1) {
      const address = XLSX.utils.encode_cell({ r: range.s.r, c: column });
      const value = formatCellValue(sheet[address]);
      if (value) {
        headerValues.push(`${XLSX.utils.encode_col(column)}=${value}`);
      }
    }
    if (headerValues.length > 0) {
      pushBoundedLine(lines, `首行列头：${headerValues.join(' | ')}`, state);
    }
    for (let row = range.s.r; row <= maxRow; row += 1) {
      const cells = [];
      for (let column = range.s.c; column <= maxColumn; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address];
        const value = formatCellValue(cell);
        if (!value && !(cell && cell.f) && !(cell && cell.l) && !(cell && cell.c)) {
          continue;
        }
        const parts = [];
        if (value) {
          parts.push(value.replace(/\s+/g, ' '));
        }
        if (cell && cell.f) {
          parts.push(`公式=${cell.f}`);
        }
        if (cell && cell.l && cell.l.Target) {
          parts.push(`链接=${cell.l.Target}`);
        }
        if (cell && Array.isArray(cell.c) && cell.c.length > 0) {
          parts.push(`批注=${cell.c.map((comment) => comment.t || '').filter(Boolean).join(' ')}`);
        }
        cells.push(`${XLSX.utils.encode_col(column)}(${address})=${parts.join('；')}`);
      }
      if (cells.length > 0 && !pushBoundedLine(lines, `R${row + 1} | ${cells.join(' | ')}`, state)) {
        break;
      }
    }
  }

  return {
    kind: 'xlsx_semantic_text',
    source: 'server',
    extractorVersion: SPREADSHEET_SEMANTIC_EXTRACTOR_VERSION,
    text: lines.join('\n').trim(),
    truncated: state.truncated,
    sheetCount: workbook.SheetNames.length,
    includedSheetCount: sheetNames.length,
    rowLimit: limits.rowLimit,
    columnLimit: limits.columnLimit,
    charLimit: limits.charLimit
  };
}

function extractTextPreview(buffer, type) {
  if (type === 'spreadsheet') {
    return extractSpreadsheetText(buffer);
  }
  if (type !== 'text') {
    return '';
  }
  return buffer.toString('utf8').replace(/\0/g, '').slice(0, 12000);
}

function readAnalysisString(value, limit = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeClientAttachmentAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const summary = readAnalysisString(value.summary, 1200);
  if (!summary) {
    return null;
  }
  const memoryCategory = ['programming', 'design', 'art', 'general', 'pm', 'project'].includes(value.memoryCategory)
    ? value.memoryCategory
    : 'project';
  return {
    provider: value.provider === 'local_claude_code' ? 'local_claude_code' : 'client',
    summary,
    memoryCategory,
    shouldRemember: value.shouldRemember !== false,
    reason: readAnalysisString(value.reason, 1200) || '客户端本机 Claude Code 已完成图片分析，等待用户确认是否加入记忆区。',
    extractedText: readAnalysisString(value.extractedText, 8000)
  };
}

function buildImageFallbackAnalysis({ fileName, size }) {
  const reason = '点击加入记忆区后，将由客户端本机 Claude Code 进行视觉分析。';
  return {
    provider: 'local_claude_code_pending',
    summary: `图片已上传：${fileName}，大小 ${size} 字节。`,
    memoryCategory: 'project',
    shouldRemember: false,
    reason,
    extractedText: ''
  };
}

function isUsableImageAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return false;
  }
  if (analysis.provider === 'local_claude_code_pending') {
    return false;
  }
  const summary = typeof analysis.summary === 'string' ? analysis.summary.trim() : '';
  if (!summary) {
    return false;
  }
  return !summary.includes('图片已保存；如需视觉分析');
}

function getDeepAttachmentPaths(metadata, baizeRoot = paths.BAIZE_ROOT) {
  const root = path.join(baizeRoot, 'memory', 'deep', 'attachments');
  const attachmentDir = path.join(root, metadata.id);
  return {
    root,
    attachmentDir,
    imagePath: path.join(attachmentDir, sanitizeFileName(metadata.fileName)),
    analysisPath: path.join(attachmentDir, 'analysis.md')
  };
}

function formatImageAnalysisDocument(metadata, analysis, imageRelativePath, now) {
  const extractedText = typeof analysis.extractedText === 'string' && analysis.extractedText.trim() !== ''
    ? analysis.extractedText.trim()
    : '无';
  return [
    `# 图片记忆：${metadata.fileName}`,
    '',
    `- 附件 ID：${metadata.id}`,
    `- 文件名：${metadata.fileName}`,
    `- MIME：${metadata.mimeType || '未知'}`,
    `- 大小：${metadata.size} 字节`,
    `- 记忆分类：${analysis.memoryCategory || metadata.memory.category || 'project'}`,
    `- 图片文件：${imageRelativePath}`,
    `- 写入时间：${now.toISOString()}`,
    '',
    '## 视觉摘要',
    '',
    analysis.summary,
    '',
    '## 记忆理由',
    '',
    analysis.reason || '客户端本机 Claude Code 已完成图片分析。',
    '',
    '## 提取文字',
    '',
    extractedText,
    ''
  ].join('\n');
}

async function writeImageDeepMemory(metadata, analysis, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const uploadPaths = getAttachmentPaths(baizeRoot);
  const sourcePath = ensureInside(metadata.storagePath, uploadPaths.root);
  const deepPaths = getDeepAttachmentPaths(metadata, baizeRoot);
  const imagePath = ensureInside(deepPaths.imagePath, deepPaths.root);
  const analysisPath = ensureInside(deepPaths.analysisPath, deepPaths.root);
  await fs.mkdir(deepPaths.attachmentDir, { recursive: true });
  await fs.copyFile(sourcePath, imagePath);
  const imageRelativePath = path.relative(path.dirname(analysisPath), imagePath).replace(/\\/g, '/');
  await writeText(analysisPath, formatImageAnalysisDocument(metadata, analysis, imageRelativePath, now), deepPaths.root);
  return { imagePath, analysisPath };
}

function formatImageShallowMemoryContent(metadata, analysis, deepMemory) {
  return [
    `上传图片：${metadata.fileName}`,
    `附件 ID：${metadata.id}`,
    `摘要：${analysis.summary}`,
    `深层记忆：${deepMemory.analysisPath}`,
    `说明：${analysis.reason || '图片视觉分析结果已保存到深层记忆。'}`
  ].join('\n');
}

async function buildAnalysis({ fileName, mimeType, size, type, textPreview, contentBase64, baizeRoot, clientAnalysis }) {
  if (type === 'image') {
    return buildImageFallbackAnalysis({ fileName, size });
  }

  if (type === 'archive') {
    return {
      summary: `收到压缩文件 ${fileName}，大小 ${size} 字节。确认加入记忆区后，服务器会安全解压并生成文件索引。`,
      memoryCategory: 'project',
      shouldRemember: true,
      reason: '压缩文件需要先解压，再把可读内容摘要写入浅层记忆，把解压目录写入深层记忆索引。',
      extractedText: ''
    };
  }

  if (type === 'text' || type === 'spreadsheet') {
    const compact = textPreview.replace(/\s+/g, ' ').trim();
    const label = type === 'spreadsheet' ? '表格文件' : '文本文件';
    return {
      summary: compact ? `收到${label} ${fileName}：${compact.slice(0, 800)}` : `收到${label} ${fileName}。`,
      memoryCategory: 'project',
      shouldRemember: compact.length > 0,
      reason: compact.length > 0 ? '文件包含可读文本，可作为项目上下文加入记忆区。' : '文件没有提取到有效文本，暂不建议加入浅层记忆。',
      extractedText: textPreview
    };
  }

  return {
    summary: `收到文件 ${fileName}，类型 ${mimeType || '未知'}，大小 ${size} 字节。当前版本不会解析二进制内容。`,
    memoryCategory: 'project',
    shouldRemember: false,
    reason: '二进制文件无法直接提取文本，暂不建议加入记忆区。',
    extractedText: ''
  };
}

function publicAttachment(metadata) {
  return {
    id: metadata.id,
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    size: metadata.size,
    type: metadata.type,
    conversationId: metadata.conversationId,
    clientId: metadata.clientId,
    createdAt: metadata.createdAt,
    analysis: metadata.analysis,
    memory: metadata.memory,
    extraction: metadata.extraction
  };
}

async function writeBinary(filePath, buffer, allowedRoot) {
  ensureInside(filePath, allowedRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

function runArchiveCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(path7za, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout && child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr && child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(validationError(`压缩文件解压失败：${(stderr || stdout).trim().slice(0, 300) || '7zip returned non-zero exit code.'}`, 'ARCHIVE_EXTRACT_FAILED', 400));
    });
  });
}

function assertSafeArchiveEntry(entryPath) {
  const normalized = String(entryPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(entryPath)) {
    throw validationError('压缩文件包含不安全路径，已拒绝解压。', 'ARCHIVE_UNSAFE_PATH', 400);
  }
}

function parseArchiveList(output) {
  const entries = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (line.trim() === '') {
      if (current && current.path) {
        entries.push(current);
      }
      current = null;
      continue;
    }
    const match = line.match(/^([^=]+)=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    current = current || {};
    if (key === 'Path') {
      current.path = value;
    } else if (key === 'Size') {
      current.size = Number.parseInt(value, 10) || 0;
    } else if (key === 'Attributes') {
      current.isDirectory = value.includes('D');
    }
  }
  if (current && current.path) {
    entries.push(current);
  }
  return entries;
}

async function assertArchiveIsSafe(filePath) {
  const output = await runArchiveCommand(['l', '-slt', filePath]);
  const entries = parseArchiveList(output).filter((entry) => entry.path !== filePath && !entry.isDirectory);
  if (entries.length > MAX_ARCHIVE_FILES) {
    throw validationError(`压缩文件内文件数量不能超过 ${MAX_ARCHIVE_FILES} 个。`, 'ARCHIVE_TOO_MANY_FILES', 413);
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_ARCHIVE_EXTRACTED_BYTES) {
    throw validationError('压缩文件解压后内容不能超过 50MB。', 'ARCHIVE_TOO_LARGE', 413);
  }
  entries.forEach((entry) => assertSafeArchiveEntry(entry.path));
}

async function collectExtractedFiles(root, allowedRoot) {
  const files = [];
  async function walk(dir) {
    ensureInside(dir, allowedRoot);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      ensureInside(target, allowedRoot);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(target);
      files.push({ path: target, relativePath: path.relative(root, target).replace(/\\/g, '/'), size: stat.size });
    }
  }
  await walk(root);
  if (files.length > MAX_ARCHIVE_FILES) {
    throw validationError(`压缩文件内文件数量不能超过 ${MAX_ARCHIVE_FILES} 个。`, 'ARCHIVE_TOO_MANY_FILES', 413);
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ARCHIVE_EXTRACTED_BYTES) {
    throw validationError('压缩文件解压后内容不能超过 50MB。', 'ARCHIVE_TOO_LARGE', 413);
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readExtractedPreview(file) {
  const extension = path.extname(file.path).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) || file.size > 1024 * 1024) {
    return '';
  }
  const text = await fs.readFile(file.path, 'utf8');
  return text.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function extractArchiveAttachment(metadata) {
  const extractedDir = path.join(path.dirname(metadata.storagePath), 'extracted');
  await assertArchiveIsSafe(metadata.storagePath);
  await fs.rm(extractedDir, { recursive: true, force: true });
  await fs.mkdir(extractedDir, { recursive: true });
  await runArchiveCommand(['x', '-y', `-o${extractedDir}`, metadata.storagePath]);
  const files = await collectExtractedFiles(extractedDir, path.dirname(metadata.storagePath));
  const indexedFiles = await Promise.all(files.map(async (file) => ({
    ...file,
    preview: await readExtractedPreview(file)
  })));
  return { extractedDir, files: indexedFiles };
}

function formatArchiveMemoryContent(metadata, extraction) {
  const lines = extraction.files.slice(0, 50).map((file) => {
    const preview = file.preview ? ` 摘要：${file.preview}` : '';
    return `- ${file.relativePath} (${file.size} bytes)${preview}`;
  });
  return [
    `上传压缩文件：${metadata.fileName}`,
    `摘要：已解压 ${extraction.files.length} 个文件到深层记忆目录。`,
    '文件索引：',
    lines.length > 0 ? lines.join('\n') : '- 无可索引文件'
  ].join('\n');
}

async function uploadAttachment(input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  const buffer = decodeBase64(input.contentBase64);
  const safeFileName = sanitizeFileName(input.fileName);
  const id = `att-${crypto.randomUUID()}`;
  const uploadPaths = getAttachmentPaths(baizeRoot);
  const attachmentDir = path.join(uploadPaths.root, id);
  const filePath = path.join(attachmentDir, safeFileName);
  const type = classifyAttachment({ fileName: safeFileName, mimeType: input.mimeType, buffer });
  const textPreview = extractTextPreview(buffer, type);
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType : '';
  const contentBase64 = buffer.toString('base64');
  const analysis = await buildAnalysis({
    fileName: safeFileName,
    mimeType,
    size: buffer.length,
    type,
    textPreview,
    contentBase64,
    baizeRoot,
    clientAnalysis: input.clientAnalysis
  });
  const metadata = {
    id,
    fileName: safeFileName,
    mimeType: typeof input.mimeType === 'string' ? input.mimeType : '',
    size: buffer.length,
    type,
    conversationId: assertSafeId(input.conversationId, 'conversationId'),
    clientId: typeof input.clientId === 'string' && input.clientId.trim() !== '' ? input.clientId.trim() : null,
    userId: typeof input.userId === 'string' && input.userId.trim() !== '' ? input.userId.trim() : null,
    storagePath: filePath,
    analysis,
    memory: {
      status: 'pending_confirmation',
      category: analysis.memoryCategory,
      rememberedAt: null
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };

  await writeBinary(filePath, buffer, uploadPaths.root);
  await writeJson(path.join(attachmentDir, 'metadata.json'), metadata, uploadPaths.root);
  return publicAttachment(metadata);
}

async function getAttachment(attachmentId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const id = assertSafeId(attachmentId, 'attachmentId');
  const uploadPaths = getAttachmentPaths(baizeRoot);
  const metadata = await readJsonIfExists(path.join(uploadPaths.root, id, 'metadata.json'), null);
  if (!metadata) {
    throw validationError('附件不存在。', 'ATTACHMENT_NOT_FOUND', 404);
  }
  return metadata;
}

function getSpreadsheetSemanticExtractionCachePath(metadata) {
  return path.join(path.dirname(metadata.storagePath), 'semantic-extraction.json');
}

function isValidSpreadsheetSemanticCache(cache, metadata, sourceStat) {
  return cache &&
    cache.attachmentId === metadata.id &&
    cache.conversationId === metadata.conversationId &&
    cache.sourceSize === metadata.size &&
    cache.extractorVersion === SPREADSHEET_SEMANTIC_EXTRACTOR_VERSION &&
    (!sourceStat || cache.sourceMtimeMs === sourceStat.mtimeMs) &&
    cache.extraction &&
    cache.extraction.kind === 'xlsx_semantic_text' &&
    typeof cache.extraction.text === 'string';
}

async function ensureSpreadsheetSemanticExtraction(metadata, { baizeRoot = paths.BAIZE_ROOT, now = new Date() } = {}) {
  if (!metadata || metadata.type !== 'spreadsheet' || !metadata.storagePath) {
    return null;
  }
  const uploadPaths = getAttachmentPaths(baizeRoot);
  const sourcePath = ensureInside(metadata.storagePath, uploadPaths.root);
  const sourceStat = await fs.stat(sourcePath);
  const cachePath = getSpreadsheetSemanticExtractionCachePath(metadata);
  const cached = await readJsonIfExists(cachePath, null);
  if (isValidSpreadsheetSemanticCache(cached, metadata, sourceStat)) {
    return { ...cached.extraction, cached: true };
  }

  const buffer = await fs.readFile(sourcePath);
  const extraction = extractSpreadsheetSemanticText(buffer);
  const cache = {
    attachmentId: metadata.id,
    conversationId: metadata.conversationId,
    fileName: metadata.fileName,
    type: metadata.type,
    extractorVersion: SPREADSHEET_SEMANTIC_EXTRACTOR_VERSION,
    sourceSize: metadata.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    createdAt: cached && cached.createdAt ? cached.createdAt : now.toISOString(),
    updatedAt: now.toISOString(),
    extraction
  };
  await writeJson(cachePath, cache, uploadPaths.root);
  return { ...extraction, cached: false };
}

async function listConversationAttachments(conversationId, { baizeRoot = paths.BAIZE_ROOT } = {}) {
  const id = assertSafeId(conversationId, 'conversationId');
  const uploadPaths = getAttachmentPaths(baizeRoot);
  let entries = [];
  try {
    entries = await fs.readdir(uploadPaths.root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const attachments = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJsonIfExists(path.join(uploadPaths.root, entry.name, 'metadata.json'), null)));
  return attachments
    .filter((attachment) => attachment && attachment.conversationId === id)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

async function rememberAttachment(attachmentId, input = {}, { baizeRoot = paths.BAIZE_ROOT, now = new Date(), archiveExtractor = extractArchiveAttachment } = {}) {
  const metadata = await getAttachment(attachmentId, { baizeRoot });
  const clientAnalysis = metadata.type === 'image' ? normalizeClientAttachmentAnalysis(input.clientAnalysis) : null;
  const analysis = metadata.type === 'image' ? clientAnalysis : metadata.analysis;
  const category = typeof input.category === 'string' && input.category.trim() !== ''
    ? input.category.trim()
    : analysis.memoryCategory || metadata.memory.category;

  if (metadata.type === 'image' && !isUsableImageAnalysis(analysis)) {
    throw validationError('图片加入记忆区前必须完成本机 Claude Code 视觉分析。请确认客户端本机 Claude Code 可用后重试。', 'IMAGE_ANALYSIS_REQUIRED', 400);
  }

  const normalizedMetadata = metadata.type === 'image'
    ? { ...metadata, analysis: { ...analysis, memoryCategory: category } }
    : metadata;
  const extraction = normalizedMetadata.type === 'archive' ? await archiveExtractor(normalizedMetadata) : null;
  const imageDeepMemory = normalizedMetadata.type === 'image'
    ? await writeImageDeepMemory(normalizedMetadata, normalizedMetadata.analysis, { baizeRoot, now })
    : null;
  const content = imageDeepMemory
    ? formatImageShallowMemoryContent(normalizedMetadata, normalizedMetadata.analysis, imageDeepMemory)
    : extraction
      ? formatArchiveMemoryContent(normalizedMetadata, extraction)
      : normalizedMetadata.analysis.extractedText
        ? `上传文件：${normalizedMetadata.fileName}\n摘要：${normalizedMetadata.analysis.summary}\n内容摘录：${normalizedMetadata.analysis.extractedText.slice(0, 4000)}`
        : `上传文件：${normalizedMetadata.fileName}\n摘要：${normalizedMetadata.analysis.summary}\n说明：${normalizedMetadata.analysis.reason}`;
  const deepPath = imageDeepMemory ? imageDeepMemory.analysisPath : extraction ? extraction.extractedDir : normalizedMetadata.storagePath;
  const deepSummary = imageDeepMemory
    ? normalizedMetadata.analysis.summary
    : extraction
      ? `压缩文件 ${normalizedMetadata.fileName} 已解压并索引 ${extraction.files.length} 个文件。`
      : normalizedMetadata.analysis.summary;

  const shallow = await addShallowMemory({
    category,
    content,
    source: `attachment:${normalizedMetadata.id}`,
    now,
    baizeRoot
  });
  const deep = await addDeepMemoryIndex({
    category,
    title: normalizedMetadata.fileName,
    path: deepPath,
    tags: imageDeepMemory ? ['上传图片', normalizedMetadata.type] : ['上传文件', normalizedMetadata.type],
    summary: deepSummary,
    now,
    baizeRoot
  });

  const updated = {
    ...normalizedMetadata,
    extraction: extraction ? {
      extractedDir: extraction.extractedDir,
      fileCount: extraction.files.length,
      files: extraction.files.map((file) => ({ relativePath: file.relativePath, size: file.size }))
    } : normalizedMetadata.extraction,
    memory: {
      status: 'remembered',
      category,
      rememberedAt: now.toISOString(),
      shallowFile: shallow.file,
      deepIndexFile: deep.indexFile,
      deepAnalysisFile: imageDeepMemory ? imageDeepMemory.analysisPath : undefined,
      deepAttachmentFile: imageDeepMemory ? imageDeepMemory.imagePath : undefined
    },
    updatedAt: now.toISOString()
  };
  const uploadPaths = getAttachmentPaths(baizeRoot);
  await writeJson(path.join(uploadPaths.root, normalizedMetadata.id, 'metadata.json'), updated, uploadPaths.root);
  return publicAttachment(updated);
}

module.exports = {
  MAX_UPLOAD_BYTES,
  uploadAttachment,
  getAttachment,
  listConversationAttachments,
  rememberAttachment,
  extractArchiveAttachment,
  extractSpreadsheetSemanticText,
  ensureSpreadsheetSemanticExtraction
};
