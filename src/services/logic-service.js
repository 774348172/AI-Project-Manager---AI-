const fs = require('fs/promises');
const path = require('path');
const paths = require('../config/paths');
const { appendText, readTextIfExists } = require('../lib/file-store');
const { formatLogicAssertionEntry, formatLogicDraftEntry } = require('../lib/markdown');

const LOGIC_CATEGORIES = ['programming', 'design', 'art', 'general', 'pm', 'project', 'identity'];

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function assertLogicCategory(category) {
  if (!LOGIC_CATEGORIES.includes(category)) {
    throw validationError('INVALID_CATEGORY', 'Unsupported category.');
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError('VALIDATION_ERROR', `${field} is required.`);
  }
}

async function listContextFiles(directory, extension) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

async function getLogicContext({ baizeRoot = paths.BAIZE_ROOT, includeDrafts = false } = {}) {
  const assertionsDir = path.join(baizeRoot, 'logic', 'assertions');
  const rulesDir = path.join(baizeRoot, 'logic', 'rules');
  const executableDir = path.join(baizeRoot, 'logic', 'executable');

  const assertionFiles = (await listContextFiles(assertionsDir, '.md'))
    .filter((fileName) => includeDrafts || fileName !== 'drafts.md');
  const ruleFiles = await listContextFiles(rulesDir, '.md');
  const executableFiles = await listContextFiles(executableDir, '.yaml');

  const assertions = await Promise.all(assertionFiles.map(async (fileName) => ({
    category: stripExtension(fileName),
    relativePath: path.join('logic', 'assertions', fileName),
    content: await readTextIfExists(path.join(assertionsDir, fileName))
  })));

  const rules = await Promise.all(ruleFiles.map(async (fileName) => ({
    name: stripExtension(fileName),
    relativePath: path.join('logic', 'rules', fileName),
    content: await readTextIfExists(path.join(rulesDir, fileName))
  })));

  const executableRules = await Promise.all(executableFiles.map(async (fileName) => ({
    name: stripExtension(fileName),
    relativePath: path.join('logic', 'executable', fileName),
    content: await readTextIfExists(path.join(executableDir, fileName))
  })));

  return { assertions, rules, executableRules };
}

async function submitLogicAssertion({
  baizeRoot = paths.BAIZE_ROOT,
  category,
  statement,
  source = 'passive_detected',
  now
} = {}) {
  assertLogicCategory(category);
  requireText(statement, 'statement');

  const assertionsDir = path.join(baizeRoot, 'logic', 'assertions');

  if (source === 'manual') {
    const file = path.join(assertionsDir, `${category}.md`);
    await appendText(file, formatLogicAssertionEntry({ statement, source, now }), assertionsDir);
    return { category, requiresConfirmation: false, file };
  }

  const file = path.join(assertionsDir, 'drafts.md');
  await appendText(file, formatLogicDraftEntry({ category, statement, source, now }), assertionsDir);
  return { category, requiresConfirmation: true, file };
}

module.exports = {
  LOGIC_CATEGORIES,
  getLogicContext,
  submitLogicAssertion
};
