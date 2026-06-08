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

  it('uses client-bound Jira credentials before server runtime credentials', () => {
    const config = mergeJiraConfig({
      enabled: true,
      baseURL: 'http://jira.public.test',
      defaultProjectKey: 'PUBLIC'
    }, {
      baseURL: 'http://jira.local.test',
      username: 'local-user',
      password: 'local-password',
      defaultProjectKey: 'LOCAL'
    }, {}, {
      baseURL: 'http://jira.runtime.test',
      username: 'runtime-user',
      password: 'runtime-password',
      defaultProjectKey: 'RUNTIME'
    });

    expect(config.baseURL).toBe('http://jira.local.test');
    expect(config.username).toBe('local-user');
    expect(config.password).toBe('local-password');
    expect(config.defaultProjectKey).toBe('LOCAL');
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

  it('reads and writes Jira binding through the client account store when available', async () => {
    const { baizeRoot } = await createTestRoot();
    const accountStore = {
      binding: {},
      async getBindingConfig() {
        return this.binding;
      },
      async saveJiraBinding(input) {
        this.binding = { ...this.binding, ...input };
        return { bindings: { jira: { credentialConfigured: Boolean(input.password), username: input.username } } };
      }
    };
    const store = createJiraConfigStore({
      userDataPath: path.join(baizeRoot, 'user-data'),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (buffer) => buffer.toString('utf8')
      },
      accountStore,
      getPublicConfig: async () => ({ baseURL: 'http://jira.public.test' }),
      getRuntimeConfig: async () => ({ jira: { username: 'runtime-user', password: 'runtime-password' } }),
      env: {}
    });

    await store.saveConfig({ baseURL: 'http://jira.bound.test', username: 'bound-user', password: 'bound-password' });
    const config = await store.getConfig();

    expect(config.baseURL).toBe('http://jira.bound.test');
    expect(config.username).toBe('bound-user');
    expect(config.password).toBe('bound-password');
  });
});
