const { createTestRoot } = require('./helpers/test-root');
const { createClientAccountStore, createMachineCode } = require('../client/desktop/client-account-store.cjs');

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^encrypted:/, '')
  };
}

describe('desktop client account store', () => {
  it('creates a machine-bound public account without credentials', async () => {
    const { baizeRoot } = await createTestRoot();
    const store = createClientAccountStore({
      userDataPath: baizeRoot,
      safeStorage: createSafeStorage(),
      getClientId: async () => 'desktop-client-1',
      getMachineCode: async () => 'machine-code-1'
    });

    const account = await store.getPublicAccount();

    expect(account).toMatchObject({
      clientId: 'desktop-client-1',
      machineCode: 'machine-code-1',
      bindings: {
        svn: { credentialConfigured: false },
        jira: { credentialConfigured: false },
        wecom: { userConfigured: false }
      }
    });
    expect(JSON.stringify(account)).not.toContain('password');
    expect(JSON.stringify(account)).not.toContain('apiToken');
  });

  it('saves optional plugin bindings and decrypts them for local plugin calls', async () => {
    const { baizeRoot } = await createTestRoot();
    const store = createClientAccountStore({
      userDataPath: baizeRoot,
      safeStorage: createSafeStorage(),
      getClientId: async () => 'desktop-client-1',
      getMachineCode: async () => 'machine-code-1'
    });

    await store.saveSvnBinding({ username: 'svn-user', password: 'svn-secret', workspacePath: 'D:/work/project', unityExePath: 'D:/Unity/Editor/Unity.exe', validationCommand: 'Unity.exe -batchmode -quit' });
    await store.saveJiraBinding({ baseURL: 'http://jira.test', username: 'jira-user', password: 'jira-secret', defaultProjectKey: 'BUG' });
    const account = await store.saveWeComBinding({ userId: 'wecom-user', webhookUrl: 'https://wecom.test/hook' });

    expect(account.bindings.svn).toMatchObject({ credentialConfigured: true, workspacePath: 'D:/work/project', unityExePath: 'D:/Unity/Editor/Unity.exe', validationCommand: 'Unity.exe -batchmode -quit' });
    expect(account.bindings.jira).toMatchObject({ credentialConfigured: true, baseURL: 'http://jira.test', username: 'jira-user', defaultProjectKey: 'BUG' });
    expect(account.bindings.wecom.userConfigured).toBe(true);
    expect(JSON.stringify(account)).not.toContain('secret');
    await expect(store.getBindingConfig('svn')).resolves.toMatchObject({ username: 'svn-user', password: 'svn-secret', workspacePath: 'D:/work/project', unityExePath: 'D:/Unity/Editor/Unity.exe', validationCommand: 'Unity.exe -batchmode -quit' });
    await expect(store.getBindingConfig('jira')).resolves.toMatchObject({ username: 'jira-user', password: 'jira-secret' });
    await expect(store.getBindingConfig('wecom')).resolves.toMatchObject({ userId: 'wecom-user', webhookUrl: 'https://wecom.test/hook' });
  });

  it('returns Jira API Token only for the local editable account view', async () => {
    const { baizeRoot } = await createTestRoot();
    const store = createClientAccountStore({
      userDataPath: baizeRoot,
      safeStorage: createSafeStorage(),
      getClientId: async () => 'desktop-client-1',
      getMachineCode: async () => 'machine-code-1'
    });

    await store.saveJiraBinding({ username: 'jira-user', apiToken: 'jira-token', defaultProjectKey: 'BUG' });
    const publicAccount = await store.getPublicAccount();
    const editableAccount = await store.getEditableAccount();

    expect(JSON.stringify(publicAccount)).not.toContain('jira-token');
    expect(editableAccount.bindings.jira).toMatchObject({ username: 'jira-user', apiToken: 'jira-token', defaultProjectKey: 'BUG' });
  });

  it('creates stable machine code from host seed', () => {
    expect(createMachineCode({ hostname: 'QA-PC', platform: 'win32', arch: 'x64', userInfo: { username: 'qa' } })).toBe(
      createMachineCode({ hostname: 'QA-PC', platform: 'win32', arch: 'x64', userInfo: { username: 'qa' } })
    );
  });
});
