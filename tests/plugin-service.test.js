const fs = require('fs/promises');
const path = require('path');
const { getSkillsContext, pluginPlaceholder } = require('../src/services/plugin-service');
const { createTestRoot } = require('./helpers/test-root');

describe('plugin service', () => {
  it('returns reserved plugin placeholder', () => {
    expect(pluginPlaceholder()).toMatchObject({ implemented: false });
  });

  it('reads skills registry, markdown, and config as context', async () => {
    const { baizeRoot } = await createTestRoot();
    const skillDir = path.join(baizeRoot, 'skills', 'knowledge-base');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'skills', 'registry.yaml'), 'skills:\n  - id: knowledge-base\n', 'utf8');
    await fs.writeFile(path.join(skillDir, 'skill.md'), '# 知识库技能\n\n检索项目知识。', 'utf8');
    await fs.writeFile(path.join(skillDir, 'config.yaml'), 'enabled: true\n', 'utf8');

    const context = await getSkillsContext({ baizeRoot });

    expect(context.registry).toContain('knowledge-base');
    expect(context.skills).toEqual([
      {
        id: 'knowledge-base',
        relativePath: path.join('skills', 'knowledge-base'),
        skillMarkdown: '# 知识库技能\n\n检索项目知识。',
        configYaml: 'enabled: true\n'
      }
    ]);
  });
});
