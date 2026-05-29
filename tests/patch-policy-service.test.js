const { parsePatchFiles, validatePatch } = require('../src/services/patch-policy-service');

describe('patch policy service', () => {
  it('summarizes safe unified diffs', () => {
    const patch = [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new'
    ].join('\n');

    expect(validatePatch(patch).files).toEqual([{
      path: 'src/app.js',
      changeType: 'modify',
      additions: 1,
      deletions: 1
    }]);
  });

  it('rejects unsafe patch paths', () => {
    const cases = [
      'diff --git a/.env b/.env',
      'diff --git a/../outside.js b/../outside.js',
      'diff --git a/src/app.js b/C:/Users/secret.js',
      'diff --git a/node_modules/pkg/index.js b/node_modules/pkg/index.js'
    ];

    for (const firstLine of cases) {
      expect(() => parsePatchFiles(`${firstLine}\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b`)).toThrow();
    }
  });

  it('rejects binary patches', () => {
    expect(() => validatePatch('GIT binary patch\nliteral 1')).toThrow('暂不支持二进制补丁。');
  });
});
