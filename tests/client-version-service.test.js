const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const {
  compareVersion,
  getClientVersionStatus,
  getClientUpdateFile
} = require('../src/services/client-version-service');

describe('client version service', () => {
  it('compares semantic versions', () => {
    expect(compareVersion('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersion('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersion('0.1.0', '0.2.0')).toBe(-1);
  });

  it('returns forced update status without exposing local file paths', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'client-version.yaml'), [
      'enabled: true',
      'currentVersion: "0.2.0"',
      'minimumVersion: "0.2.0"',
      'forceUpdate: true',
      'releaseNotes: "必须更新。"',
      'windows:',
      '  updateDir: "D:/secret/update-dir"'
    ].join('\n'), 'utf8');

    const status = await getClientVersionStatus({
      version: '0.1.0',
      platform: 'windows',
      serverBaseUrl: 'http://127.0.0.1:3000'
    }, { baizeRoot });

    expect(status).toMatchObject({
      enabled: true,
      currentVersion: '0.2.0',
      clientVersion: '0.1.0',
      updateAvailable: true,
      updateRequired: true,
      forceUpdate: true,
      updateUrl: 'http://127.0.0.1:3000/client-updates/windows'
    });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('does not lock the client when force update is enabled but versions match', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'client-version.yaml'), [
      'enabled: true',
      'currentVersion: "0.2.0"',
      'minimumVersion: "0.2.0"',
      'forceUpdate: true'
    ].join('\n'), 'utf8');

    const status = await getClientVersionStatus({ version: '0.2.0', platform: 'windows' }, { baizeRoot });

    expect(status.updateAvailable).toBe(false);
    expect(status.updateRequired).toBe(false);
  });

  it('serves only configured update files', async () => {
    const { baizeRoot } = await createTestRoot();
    const updateDir = path.join(baizeRoot, 'client-updates', 'windows');
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.mkdir(updateDir, { recursive: true });
    await fs.writeFile(path.join(updateDir, 'latest.yml'), 'version: 0.2.0\n', 'utf8');
    await fs.writeFile(path.join(baizeRoot, 'config', 'client-version.yaml'), [
      'enabled: true',
      'currentVersion: "0.2.0"',
      'windows:',
      `  updateDir: "${updateDir.replace(/\\/g, '/')}"`,
      '  latestYml: "latest.yml"',
      '  installer: "白泽.exe"',
      '  blockMap: "白泽.exe.blockmap"'
    ].join('\n'), 'utf8');

    await expect(getClientUpdateFile('latest.yml', { baizeRoot })).resolves.toMatchObject({ fileName: 'latest.yml' });
    await expect(getClientUpdateFile('../client-version.yaml', { baizeRoot })).rejects.toMatchObject({ code: 'INVALID_UPDATE_FILE' });
    await expect(getClientUpdateFile('secret.txt', { baizeRoot })).rejects.toMatchObject({ code: 'INVALID_UPDATE_FILE' });
  });
});
