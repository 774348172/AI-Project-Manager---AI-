const fs = require('fs/promises');
const path = require('path');
const { getLogicContext, submitLogicAssertion } = require('../src/services/logic-service');
const { createTestRoot } = require('./helpers/test-root');

describe('logic service', () => {
  it('writes passive_detected assertions to drafts and requires confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    const now = new Date('2026-05-19T10:00:00.000Z');

    const result = await submitLogicAssertion({
      category: 'programming',
      statement: 'Prefer CommonJS modules for this project.',
      source: 'passive_detected',
      now,
      baizeRoot
    });

    expect(result).toMatchObject({
      category: 'programming',
      requiresConfirmation: true,
      file: path.join(baizeRoot, 'logic', 'assertions', 'drafts.md')
    });

    const draftContent = await fs.readFile(result.file, 'utf8');
    expect(draftContent).toContain('## 2026-05-19T10:00:00.000Z');
    expect(draftContent).toContain('- 分类：programming');
    expect(draftContent).toContain('- 来源：passive_detected');
    expect(draftContent).toContain('- 待确认断言：Prefer CommonJS modules for this project.');
  });

  it('writes manual assertions to the formal category file without requiring confirmation', async () => {
    const { baizeRoot } = await createTestRoot();
    const now = new Date('2026-05-19T10:00:00.000Z');

    const result = await submitLogicAssertion({
      category: 'identity',
      statement: 'Baize stores identity assertions locally.',
      source: 'manual',
      now,
      baizeRoot
    });

    expect(result).toMatchObject({
      category: 'identity',
      requiresConfirmation: false,
      file: path.join(baizeRoot, 'logic', 'assertions', 'identity.md')
    });

    const assertionContent = await fs.readFile(result.file, 'utf8');
    expect(assertionContent).toContain('# identity\n');
    expect(assertionContent).toContain('## 2026-05-19T10:00:00.000Z');
    expect(assertionContent).toContain('- 来源：manual');
    expect(assertionContent).toContain('- 断言：Baize stores identity assertions locally.');
  });

  it('reads logic assertions, markdown rules, and executable rules as context', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'logic', 'rules'), { recursive: true });
    await fs.mkdir(path.join(baizeRoot, 'logic', 'executable'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'logic', 'assertions', 'identity.md'), '# identity\n\n白泽身份断言。', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'logic', 'rules', 'intent-routing.md'), '# 意图路由\n\n优先识别用户目标。', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'logic', 'executable', 'routing-rules.yaml'), 'rules:\n  - name: route-chat\n', 'utf8');

    const context = await getLogicContext({ baizeRoot });

    expect(context.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'identity',
        relativePath: path.join('logic', 'assertions', 'identity.md'),
        content: expect.stringContaining('白泽身份断言')
      })
    ]));
    expect(context.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'intent-routing',
        relativePath: path.join('logic', 'rules', 'intent-routing.md'),
        content: expect.stringContaining('优先识别用户目标')
      })
    ]));
    expect(context.executableRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'routing-rules',
        relativePath: path.join('logic', 'executable', 'routing-rules.yaml'),
        content: expect.stringContaining('route-chat')
      })
    ]));
  });

  it('excludes draft assertions by default and can include them explicitly', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'logic', 'assertions'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'logic', 'assertions', 'identity.md'), '# identity\n\n已确认断言。', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'logic', 'assertions', 'drafts.md'), '# drafts\n\n待确认断言。', 'utf8');

    const defaultContext = await getLogicContext({ baizeRoot });
    const withDrafts = await getLogicContext({ baizeRoot, includeDrafts: true });

    expect(defaultContext.assertions.map((item) => item.category)).not.toContain('drafts');
    expect(defaultContext.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'identity', content: expect.stringContaining('已确认断言') })
    ]));
    expect(withDrafts.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'drafts', content: expect.stringContaining('待确认断言') }),
      expect.objectContaining({ category: 'identity', content: expect.stringContaining('已确认断言') })
    ]));
  });

  it('rejects unsupported logic category', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(submitLogicAssertion({
      category: 'unknown',
      statement: 'Unknown category should fail.',
      baizeRoot
    })).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  });
});
