const fs = require('fs/promises');
const path = require('path');
const {
  addShallowMemory,
  searchShallowMemory,
  addDeepMemoryIndex
} = require('../src/services/memory-service');
const { createTestRoot } = require('./helpers/test-root');

describe('memory service', () => {
  it('appends design shallow memory preserving heading and adding timestamp, source, and content', async () => {
    const { baizeRoot } = await createTestRoot();
    const now = new Date('2026-05-19T10:00:00.000Z');

    const result = await addShallowMemory({
      category: 'design',
      content: '角色设计优先考虑移动端单手操作。',
      source: 'unit-test',
      now,
      baizeRoot
    });

    const fileContent = await fs.readFile(result.file, 'utf8');
    expect(result.category).toBe('design');
    expect(fileContent).toContain('# design\n');
    expect(fileContent).toContain('## 2026-05-19T10:00:00.000Z');
    expect(fileContent).toContain('- 来源：unit-test');
    expect(fileContent).toContain('- 内容：角色设计优先考虑移动端单手操作。');
  });

  it('searches shallow memory by category and query', async () => {
    const { baizeRoot } = await createTestRoot();
    const now = new Date('2026-05-19T10:00:00.000Z');
    await addShallowMemory({
      category: 'design',
      content: '角色设计优先考虑移动端单手操作。',
      now,
      baizeRoot
    });

    const results = await searchShallowMemory({
      category: 'design',
      q: '移动端',
      baizeRoot
    });

    expect(results).toContainEqual(expect.objectContaining({
      category: 'design',
      line: '- 内容：角色设计优先考虑移动端单手操作。'
    }));
  });

  it('rejects unsupported category', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(addShallowMemory({
      category: 'unknown',
      content: 'content',
      baizeRoot
    })).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  });

  it('appends deep memory index row and returns pathExists false when target path is missing', async () => {
    const { baizeRoot } = await createTestRoot();
    const now = new Date('2026-05-19T10:00:00.000Z');
    const memoryPath = path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project', 'missing.md');

    const result = await addDeepMemoryIndex({
      category: 'project',
      title: 'Missing project memory',
      path: memoryPath,
      tags: ['project', 'missing'],
      summary: 'Target file is not present yet.',
      now,
      baizeRoot
    });

    const indexContent = await fs.readFile(result.indexFile, 'utf8');
    expect(result).toMatchObject({
      category: 'project',
      pathExists: false
    });
    expect(indexContent).toContain('| Missing project memory |');
    expect(indexContent).toContain('| project, missing |');
    expect(indexContent).toContain('| Target file is not present yet. | 2026-05-19T10:00:00.000Z |');
  });

  it('rejects deep memory index paths outside baize root', async () => {
    const { baizeRoot } = await createTestRoot();
    const outsidePath = path.join(path.dirname(baizeRoot), 'outside.md');

    await expect(addDeepMemoryIndex({
      category: 'project',
      title: 'Outside project memory',
      path: outsidePath,
      summary: 'This path is outside the baize root.',
      baizeRoot
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'path must be inside baize root.'
    });
  });
});
