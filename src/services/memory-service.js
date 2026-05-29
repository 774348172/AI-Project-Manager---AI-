const path = require('path');
const paths = require('../config/paths');
const { readTextIfExists, appendText, exists } = require('../lib/file-store');
const { formatShallowMemoryEntry, formatDeepIndexRow } = require('../lib/markdown');

const MEMORY_CATEGORIES = ['programming', 'design', 'art', 'general', 'pm', 'project'];

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function assertMemoryCategory(category) {
  if (!MEMORY_CATEGORIES.includes(category)) {
    throw validationError('INVALID_CATEGORY', 'Unsupported category.');
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError('VALIDATION_ERROR', `${field} is required.`);
  }
}

function resolvePaths(baizeRoot = paths.BAIZE_ROOT) {
  return {
    baizeRoot,
    shallowDir: path.join(baizeRoot, 'memory', 'shallow'),
    deepIndexDir: path.join(baizeRoot, 'memory', 'deep', 'indexes')
  };
}

function assertPathInsideBaizeRoot(targetPath, baizeRoot) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(baizeRoot);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw validationError('VALIDATION_ERROR', 'path must be inside baize root.');
  }

  return resolvedTarget;
}

async function addShallowMemory({ category, content, source, now, baizeRoot } = {}) {
  assertMemoryCategory(category);
  requireText(content, 'content');

  const { shallowDir } = resolvePaths(baizeRoot);
  const file = path.join(shallowDir, `${category}.md`);

  await appendText(file, formatShallowMemoryEntry({ content, source, now }), shallowDir);

  return { category, file };
}

async function searchShallowMemory({ category, q, baizeRoot } = {}) {
  if (category !== undefined) {
    assertMemoryCategory(category);
  }

  const { shallowDir } = resolvePaths(baizeRoot);
  const categories = category ? [category] : MEMORY_CATEGORIES;
  const results = [];

  for (const memoryCategory of categories) {
    const file = path.join(shallowDir, `${memoryCategory}.md`);
    const content = await readTextIfExists(file);
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (line.trim() !== '' && (!q || line.includes(q))) {
        results.push({ category: memoryCategory, file, line });
      }
    }
  }

  return results;
}

async function addDeepMemoryIndex({ category, title, path: memoryPath, tags, summary, now, baizeRoot } = {}) {
  assertMemoryCategory(category);
  requireText(title, 'title');
  requireText(memoryPath, 'path');
  requireText(summary, 'summary');

  const resolvedPaths = resolvePaths(baizeRoot);
  const indexFile = path.join(resolvedPaths.deepIndexDir, `${category}-index.md`);
  const checkedMemoryPath = assertPathInsideBaizeRoot(memoryPath, resolvedPaths.baizeRoot);
  const pathExists = await exists(checkedMemoryPath);

  await appendText(indexFile, formatDeepIndexRow({ title, path: checkedMemoryPath, tags, summary, now }), resolvedPaths.deepIndexDir);

  return { category, indexFile, pathExists };
}

module.exports = {
  MEMORY_CATEGORIES,
  addShallowMemory,
  searchShallowMemory,
  addDeepMemoryIndex
};
