const fs = require('fs/promises');
const path = require('path');
const paths = require('../config/paths');
const { ensureInside, readText, exists } = require('../lib/file-store');
const { addDeepMemoryIndex } = require('./memory-service');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SOURCE_ROOTS = [
  { source: 'baize-docs', relativePath: path.join('docs') },
  { source: 'deep-memory', relativePath: path.join('memory', 'deep', 'partitions') },
  { source: 'deep-index', relativePath: path.join('memory', 'deep', 'indexes') },
  { source: 'knowledge-base-skill', relativePath: path.join('skills', 'knowledge-base') }
];

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function requireQuery(q) {
  if (typeof q !== 'string' || q.trim() === '') {
    throw validationError('VALIDATION_ERROR', 'q is required.');
  }

  return q.trim();
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return DEFAULT_LIMIT;
  }

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw validationError('VALIDATION_ERROR', 'limit must be an integer between 1 and 50.');
  }

  return parsed;
}

function assertInsideBaizeRoot(targetPath, baizeRoot) {
  try {
    return ensureInside(targetPath, baizeRoot);
  } catch (error) {
    if (error.code === 'PATH_OUTSIDE_ALLOWED_ROOT') {
      throw validationError('VALIDATION_ERROR', 'path must be inside baize root.');
    }

    throw error;
  }
}

function resolveSourceRoot({ baizeRoot, relativePath }) {
  const root = path.join(baizeRoot, relativePath);
  return assertInsideBaizeRoot(root, baizeRoot);
}

async function listMarkdownFiles(root, allowedRoot) {
  const checkedRoot = assertInsideBaizeRoot(root, allowedRoot);
  if (!(await exists(checkedRoot))) {
    return [];
  }

  const entries = await fs.readdir(checkedRoot, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(checkedRoot, entry.name);
    assertInsideBaizeRoot(entryPath, allowedRoot);

    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath, allowedRoot));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }

  return files;
}

async function collectDocuments(baizeRoot = paths.BAIZE_ROOT) {
  const documents = [];

  for (const sourceRoot of SOURCE_ROOTS) {
    const root = resolveSourceRoot({ baizeRoot, relativePath: sourceRoot.relativePath });
    const files = await listMarkdownFiles(root, baizeRoot);

    for (const file of files) {
      const content = await readText(file);
      documents.push({
        source: sourceRoot.source,
        title: path.basename(file, '.md'),
        path: file,
        relativePath: path.relative(baizeRoot, file),
        content
      });
    }
  }

  return documents;
}

function countOccurrences(text, query) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let count = 0;
  let index = lowerText.indexOf(lowerQuery);

  while (index !== -1) {
    count += 1;
    index = lowerText.indexOf(lowerQuery, index + lowerQuery.length);
  }

  return count;
}

function createSnippet(content, q) {
  const normalizedContent = content.replace(/\s+/g, ' ').trim();
  const index = normalizedContent.toLowerCase().indexOf(q.toLowerCase());

  if (index === -1) {
    return normalizedContent.slice(0, 160);
  }

  const start = Math.max(0, index - 60);
  const end = Math.min(normalizedContent.length, index + q.length + 100);
  return normalizedContent.slice(start, end);
}

function scoreDocument(document, q) {
  const titleMatches = countOccurrences(document.title, q);
  const pathMatches = countOccurrences(document.relativePath, q);
  const contentMatches = countOccurrences(document.content, q);

  return titleMatches * 10 + pathMatches * 6 + contentMatches;
}

async function getKnowledgeBaseStatus({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const documents = await collectDocuments(baizeRoot);

  return {
    implemented: true,
    mode: 'local_markdown',
    documentCount: documents.length,
    indexCount: documents.filter((document) => document.source === 'deep-index').length,
    sources: SOURCE_ROOTS.map((sourceRoot) => ({
      source: sourceRoot.source,
      path: path.join(baizeRoot, sourceRoot.relativePath)
    }))
  };
}

async function searchKnowledgeBase({ q, limit, baizeRoot = paths.BAIZE_ROOT } = {}) {
  const query = requireQuery(q);
  const resultLimit = normalizeLimit(limit);
  const documents = await collectDocuments(baizeRoot);

  return documents
    .map((document) => ({ document, score: scoreDocument(document, query) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.document.relativePath.localeCompare(right.document.relativePath))
    .slice(0, resultLimit)
    .map(({ document, score }) => ({
      source: document.source,
      title: document.title,
      path: document.path,
      relativePath: document.relativePath,
      snippet: createSnippet(document.content, query),
      score
    }));
}

async function registerKnowledgeBaseResult({ category, title, path: documentPath, tags, summary, baizeRoot = paths.BAIZE_ROOT } = {}) {
  const checkedPath = assertInsideBaizeRoot(documentPath, baizeRoot);
  if (!(await exists(checkedPath))) {
    throw validationError('VALIDATION_ERROR', 'path does not exist.');
  }

  return addDeepMemoryIndex({
    category,
    title,
    path: checkedPath,
    tags,
    summary,
    baizeRoot
  });
}

module.exports = {
  getKnowledgeBaseStatus,
  searchKnowledgeBase,
  registerKnowledgeBaseResult
};
