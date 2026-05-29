const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const defaultBaizeRoot = path.join(projectRoot, 'baize');

function resolveBaizeRoot() {
  if (!process.env.BAIZE_ROOT) {
    return defaultBaizeRoot;
  }

  const resolvedRoot = path.resolve(process.env.BAIZE_ROOT);
  if (!resolvedRoot.startsWith(projectRoot + path.sep)) {
    const error = new Error('BAIZE_ROOT must stay inside the project root.');
    error.code = 'BAIZE_ROOT_OUTSIDE_PROJECT';
    throw error;
  }

  return resolvedRoot;
}

const baizeRoot = resolveBaizeRoot();

const paths = {
  PROJECT_ROOT: projectRoot,
  BAIZE_ROOT: baizeRoot,
  SHALLOW_MEMORY_DIR: path.join(baizeRoot, 'memory', 'shallow'),
  DEEP_INDEX_DIR: path.join(baizeRoot, 'memory', 'deep', 'indexes'),
  LOGIC_ASSERTIONS_DIR: path.join(baizeRoot, 'logic', 'assertions'),
  GLOBAL_MD: path.join(baizeRoot, 'config', 'global.md'),
  GLOBAL_YAML: path.join(baizeRoot, 'config', 'global.yaml')
};

module.exports = paths;
