const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  getKnowledgeBaseStatus,
  searchKnowledgeBase,
  registerKnowledgeBaseResult
} = require('../src/services/knowledge-base-service');
const { createTestRoot } = require('./helpers/test-root');

describe('knowledge base service', () => {
  async function seedKnowledgeBase() {
    const { baizeRoot } = await createTestRoot();
    const docsDir = path.join(baizeRoot, 'docs');
    const skillDir = path.join(baizeRoot, 'skills', 'knowledge-base');
    const partitionDir = path.join(baizeRoot, 'memory', 'deep', 'partitions', 'project');

    await fs.mkdir(docsDir, { recursive: true });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(partitionDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'combat.md'), '# 战斗系统\n\n角色技能冷却和能量机制。', 'utf8');
    await fs.writeFile(path.join(skillDir, 'skill.md'), '# 知识库插件\n\n支持检索项目知识库。', 'utf8');
    await fs.writeFile(path.join(partitionDir, 'meeting.md'), '# 会议记录\n\n能量机制需要和角色定位联动。', 'utf8');

    return { baizeRoot, docsDir };
  }

  it('returns local markdown status', async () => {
    const { baizeRoot } = await seedKnowledgeBase();

    const status = await getKnowledgeBaseStatus({ baizeRoot });

    expect(status).toMatchObject({
      implemented: true,
      mode: 'local_markdown'
    });
    expect(status.documentCount).toBeGreaterThanOrEqual(3);
    expect(status.indexCount).toBeGreaterThanOrEqual(6);
  });

  it('searches local markdown documents with snippets', async () => {
    const { baizeRoot } = await seedKnowledgeBase();

    const results = await searchKnowledgeBase({ q: '能量机制', limit: 5, baizeRoot });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.any(String),
          title: expect.any(String),
          snippet: expect.stringContaining('能量机制'),
          score: expect.any(Number)
        })
      ])
    );
  });

  it('rejects empty queries', async () => {
    const { baizeRoot } = await seedKnowledgeBase();

    await expect(searchKnowledgeBase({ q: '', baizeRoot })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'q is required.'
    });
  });

  it('rejects invalid limits', async () => {
    const { baizeRoot } = await seedKnowledgeBase();

    await expect(searchKnowledgeBase({ q: '能量', limit: 99, baizeRoot })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'limit must be an integer between 1 and 50.'
    });
  });

  it('registers a search result into the deep memory index', async () => {
    const { baizeRoot, docsDir } = await seedKnowledgeBase();
    const documentPath = path.join(docsDir, 'combat.md');

    const result = await registerKnowledgeBaseResult({
      category: 'project',
      title: '战斗系统',
      path: documentPath,
      tags: ['知识库', '战斗'],
      summary: '战斗系统知识库文档。',
      baizeRoot
    });

    expect(result).toMatchObject({
      category: 'project',
      pathExists: true,
      indexFile: path.join(baizeRoot, 'memory', 'deep', 'indexes', 'project-index.md')
    });

    const indexContent = await fs.readFile(result.indexFile, 'utf8');
    expect(indexContent).toContain('战斗系统');
    expect(indexContent).toContain('战斗系统知识库文档。');
  });

  it('rejects index registration outside baize root', async () => {
    const { baizeRoot } = await seedKnowledgeBase();
    const outsideFile = path.join(os.tmpdir(), 'outside-knowledge.md');
    await fs.writeFile(outsideFile, 'outside', 'utf8');

    await expect(registerKnowledgeBaseResult({
      category: 'project',
      title: '外部文档',
      path: outsideFile,
      summary: '不允许登记外部文档。',
      baizeRoot
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      publicMessage: 'path must be inside baize root.'
    });
  });
});
