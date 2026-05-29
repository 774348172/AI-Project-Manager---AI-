const fs = require('fs/promises');
const path = require('path');
const paths = require('../config/paths');
const { readTextIfExists } = require('../lib/file-store');

function pluginPlaceholder() {
  return {
    implemented: false,
    message: 'Phase 1 only reserves this plugin interface.'
  };
}

async function listSkillDirectories(skillsDir) {
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function getSkillsContext({ baizeRoot = paths.BAIZE_ROOT } = {}) {
  const skillsDir = path.join(baizeRoot, 'skills');
  const registry = await readTextIfExists(path.join(skillsDir, 'registry.yaml'));
  const skillIds = await listSkillDirectories(skillsDir);
  const skills = await Promise.all(skillIds.map(async (id) => {
    const skillDir = path.join(skillsDir, id);

    return {
      id,
      relativePath: path.join('skills', id),
      skillMarkdown: await readTextIfExists(path.join(skillDir, 'skill.md')),
      configYaml: await readTextIfExists(path.join(skillDir, 'config.yaml'))
    };
  }));

  return { registry, skills };
}

module.exports = {
  pluginPlaceholder,
  getSkillsContext
};
