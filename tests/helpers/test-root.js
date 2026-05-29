const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MEMORY_CATEGORIES = ['programming', 'design', 'art', 'general', 'pm', 'project'];
const LOGIC_CATEGORIES = ['programming', 'design', 'art', 'general', 'pm', 'project', 'identity'];

async function createTestRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-test-'));
  const baizeRoot = path.join(root, 'baize');
  const shallowDir = path.join(baizeRoot, 'memory', 'shallow');
  const deepIndexDir = path.join(baizeRoot, 'memory', 'deep', 'indexes');
  const logicAssertionsDir = path.join(baizeRoot, 'logic', 'assertions');

  await fs.mkdir(shallowDir, { recursive: true });
  await fs.mkdir(deepIndexDir, { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project'), { recursive: true });
  await fs.mkdir(logicAssertionsDir, { recursive: true });

  await Promise.all([
    ...MEMORY_CATEGORIES.flatMap((category) => [
      fs.writeFile(path.join(shallowDir, `${category}.md`), `# ${category}\n`, 'utf8'),
      fs.writeFile(
        path.join(deepIndexDir, `${category}-index.md`),
        '# Index\n\n| 标题 | 路径 | 标签 | 摘要 | 更新时间 |\n|---|---|---|---|---|\n',
        'utf8'
      )
    ]),
    ...LOGIC_CATEGORIES.map((category) =>
      fs.writeFile(path.join(logicAssertionsDir, `${category}.md`), `# ${category}\n`, 'utf8')
    )
  ]);

  return { root, baizeRoot };
}

module.exports = {
  createTestRoot
};
