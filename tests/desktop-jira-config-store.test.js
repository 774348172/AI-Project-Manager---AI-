const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const { createJiraConfigStore, mergeJiraConfig, toPublicConfig } = require('../client/desktop/jira-config-store.cjs');

describe('desktop Jira config store', () => {
  it('merges public config with local environment credentials', async () => {
    const config = mergeJiraConfig({
      enabled: true,
      baseURL: 'http://jira.server.test',
      deploymentType: 'server',
      apiVersion: '2',
      authType: 'basic',
      defaultProjectKey: 'BZ',
      defaultIssueType: 'Story',
      fieldMappings: { taskOwner: 'customfield_10010' }
    }, {}, {
      username: 'local-user',
      password: 'local-password'
    });

    expect(config).toEqual({
      enabled: true,
      baseURL: 'http://jira.server.test',
      deploymentType: 'server',
      apiVersion: '2',
      authType: 'basic',
      email: null,
      username: 'local-user',
      password: 'local-password',
      apiToken: null,
      defaultProjectKey: 'BZ',
      defaultIssueType: 'Story',
      fieldMappings: { taskOwner: 'customfield_10010' }
    });
    expect(toPublicConfig(config)).toEqual({
      enabled: true,
      baseURL: 'http://jira.server.test',
      deploymentType: 'server',
      apiVersion: '2',
      authType: 'basic',
      credentialConfigured: true,
      defaultProjectKey: 'BZ',
      defaultIssueType: 'Story',
      fieldMappings: { taskOwner: 'customfield_10010' },
      fieldMappingsConfigured: true
    });
  });

  it('uses server runtime Jira credentials before local credentials', () => {
    const config = mergeJiraConfig({
      enabled: true,
      baseURL: 'http://jira.public.test',
      defaultProjectKey: 'PUBLIC'
    }, {
      username: 'local-user',
      password: 'local-password'
    }, {}, {
      baseURL: 'http://jira.runtime.test',
      username: 'runtime-user',
      password: 'runtime-password',
      defaultProjectKey: 'RUNTIME'
    });

    expect(config.baseURL).toBe('http://jira.runtime.test');
    expect(config.username).toBe('runtime-user');
    expect(config.password).toBe('runtime-password');
    expect(config.defaultProjectKey).toBe('RUNTIME');
  });

  it('keeps Jira enabled even when server and local config disable it', () => {
    const config = mergeJiraConfig({ enabled: false }, { enabled: false }, {});

    expect(config.enabled).toBe(true);
    expect(toPublicConfig(config).enabled).toBe(true);
  });

  it('saves encrypted local credentials and only returns redacted status', async () => {
    const { baizeRoot } = await createTestRoot();
    const userDataPath = path.join(baizeRoot, 'user-data');
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
      decryptString: (buffer) => buffer.toString('utf8').replace(/^encrypted:/, '')
    };
    const store = createJiraConfigStore({
      userDataPath,
      safeStorage,
      getPublicConfig: async () => ({
        enabled: true,
        baseURL: 'http://jira.test',
        authType: 'basic',
        fieldMappings: { taskOwner: 'customfield_10010' }
      }),
      env: {}
    });

    const status = await store.saveConfig({ username: 'jira-user', password: 'secret-password' });
    const config = await store.getConfig();
    const storedText = await fs.readFile(path.join(userDataPath, 'jira.local.json'), 'utf8');

    expect(status.credentialConfigured).toBe(true);
    expect(status).not.toHaveProperty('password');
    expect(config.password).toBe('secret-password');
    expect(storedText).not.toContain('secret-password');
    expect(storedText).toContain(Buffer.from('encrypted:secret-password').toString('base64'));
  });
});
