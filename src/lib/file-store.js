const fs = require('fs/promises');
const path = require('path');

function ensureInside(targetPath, allowedRoot) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(allowedRoot);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    const error = new Error('Path is outside allowed root.');
    error.code = 'PATH_OUTSIDE_ALLOWED_ROOT';
    throw error;
  }

  return resolvedTarget;
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function readTextIfExists(filePath, fallback = '') {
  try {
    return await readText(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function appendText(filePath, content, allowedRoot) {
  const target = ensureInside(filePath, allowedRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, content, 'utf8');
}

async function writeText(filePath, content, allowedRoot) {
  const target = ensureInside(filePath, allowedRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function readJsonIfExists(filePath, fallback) {
  const text = await readTextIfExists(filePath, '');
  if (text.trim() === '') {
    return fallback;
  }

  return JSON.parse(text);
}

async function writeJson(filePath, value, allowedRoot) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`, allowedRoot);
}

async function appendJsonLine(filePath, value, allowedRoot) {
  await appendText(filePath, `${JSON.stringify(value)}\n`, allowedRoot);
}

async function readJsonLinesIfExists(filePath) {
  const text = await readTextIfExists(filePath, '');
  if (text.trim() === '') {
    return [];
  }

  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ensureInside,
  readText,
  readTextIfExists,
  writeText,
  appendText,
  readJsonIfExists,
  writeJson,
  appendJsonLine,
  readJsonLinesIfExists,
  exists
};
