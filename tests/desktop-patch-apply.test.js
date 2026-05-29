const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { previewPatch, applyPatch } = require('../client/desktop/patch-apply.cjs');

describe('desktop patch apply service', () => {
  it('previews and applies a safe patch inside workspace', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-workspace-'));
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src', 'app.js'), 'old\n', 'utf8');
    const patch = [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n');

    await expect(previewPatch({ workspaceRoot, patch })).resolves.toMatchObject({
      ok: true,
      files: [expect.objectContaining({ path: 'src/app.js', additions: 1, deletions: 1 })]
    });
    await expect(applyPatch({ workspaceRoot, patch })).resolves.toEqual({
      ok: true,
      appliedFiles: ['src/app.js']
    });
    await expect(fs.readFile(path.join(workspaceRoot, 'src', 'app.js'), 'utf8')).resolves.toBe('new\n');
  });

  it('rejects unsafe patch paths before writing', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-workspace-'));
    const patch = [
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    ].join('\n');

    await expect(applyPatch({ workspaceRoot, patch })).rejects.toMatchObject({ code: 'PATCH_SECRET_PATH' });
  });

  it('does not write when patch context mismatches', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-workspace-'));
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src', 'app.js'), 'actual\n', 'utf8');
    const patch = [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n');

    await expect(applyPatch({ workspaceRoot, patch })).rejects.toMatchObject({ code: 'PATCH_CONTEXT_MISMATCH' });
    await expect(fs.readFile(path.join(workspaceRoot, 'src', 'app.js'), 'utf8')).resolves.toBe('actual\n');
  });
});
