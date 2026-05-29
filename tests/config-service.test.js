const fs = require('fs/promises');
const path = require('path');
const { createTestRoot } = require('./helpers/test-root');
const { getClaudeConfig, getPublicClaudeConfig, getClaudeCodeConfig, getPublicClaudeCodeConfig, getJiraConfig, getPublicJiraConfig } = require('../src/services/config-service');

describe('config service', () => {
  it('returns safe Claude Code defaults when config is missing', async () => {
    const { baizeRoot } = await createTestRoot();

    await expect(getClaudeCodeConfig({ baizeRoot })).resolves.toEqual({
      enabled: false,
      command: 'claude',
      timeoutMs: 300000,
      bugAnalysisTimeoutMs: 3600000,
      bugAnalysisModel: 'claude-opus-4-7',
      settingsPath: null,
      workspacePath: null,
      bugAnalysisWorkspacePath: null,
      claudeHomePath: null,
      svn: {
        username: null,
        password: null
      },
      env: {},
      routing: { autoDetectEngineeringTasks: true },
      permissions: {
        defaultMode: 'read_only',
        requireConfirmation: true
      },
      security: {
        denySecretFiles: true,
        denyOutsideWorkspace: true,
        requireConfirmationForWrites: true,
        requireConfirmationForCommands: true,
        denyDestructiveGit: true,
        denyDependencyInstall: true
      }
    });
  });

  it('returns public Claude Code config without internal security details', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude-code.yaml'), [
      'enabled: true',
      'routing:',
      '  autoDetectEngineeringTasks: true',
      'permissions:',
      '  defaultMode: read_only',
      '  requireConfirmation: true',
      'security:',
      '  denySecretFiles: true',
      '  denyDependencyInstall: true',
      '  secretPaths:',
      '    - .env',
      'env:',
      '  ANTHROPIC_AUTH_TOKEN: server-token',
      '  ANTHROPIC_BASE_URL: http://claude.example.test'
    ].join('\n'), 'utf8');

    const publicConfig = await getPublicClaudeCodeConfig({ baizeRoot });

    expect(publicConfig).toEqual({
      enabled: true,
      workspaceConfigured: false,
      bugAnalysisWorkspaceConfigured: false,
      routing: { autoDetectEngineeringTasks: true },
      permissions: {
        defaultMode: 'read_only',
        requireConfirmation: true
      }
    });
    expect(JSON.stringify(publicConfig)).not.toContain('.env');
    expect(JSON.stringify(publicConfig)).not.toContain('server-token');
    expect(JSON.stringify(publicConfig)).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(JSON.stringify(publicConfig)).not.toContain('ANTHROPIC_BASE_URL');
  });

  it('uses Anthropic auth token for server Claude config without exposing it publicly', async () => {
    const { baizeRoot } = await createTestRoot();
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalBaizeBaseUrl = process.env.BAIZE_CLAUDE_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.BAIZE_CLAUDE_BASE_URL;
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-auth-token';
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'claude.yaml'), [
      'provider: claude',
      'claude:',
      '  apiKey: stale-file-key',
      '  baseURL: https://claude.example.test',
      '  model: claude-opus-4-7'
    ].join('\n'), 'utf8');

    try {
      const config = await getClaudeConfig({ baizeRoot });
      const publicConfig = await getPublicClaudeConfig({ baizeRoot });

      expect(config.apiKey).toBeNull();
      expect(config.authToken).toBe('env-auth-token');
      expect(publicConfig).toEqual({
        provider: 'claude',
        enabled: null,
        apiKeyConfigured: true,
        baseURL: 'https://claude.example.test',
        model: 'claude-opus-4-7'
      });
      expect(JSON.stringify(publicConfig)).not.toContain('env-auth-token');
      expect(JSON.stringify(publicConfig)).not.toContain('stale-file-key');
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
      if (originalAuthToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
      }
      if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      }
      if (originalBaizeBaseUrl === undefined) {
        delete process.env.BAIZE_CLAUDE_BASE_URL;
      } else {
        process.env.BAIZE_CLAUDE_BASE_URL = originalBaizeBaseUrl;
      }
    }
  });

  it('returns Jira config and redacts credentials from public config', async () => {
    const { baizeRoot } = await createTestRoot();
    await fs.mkdir(path.join(baizeRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(baizeRoot, 'config', 'jira.yaml'), [
      'enabled: true',
      'baseURL: http://127.0.0.1:8080',
      'deploymentType: server',
      'username: jira-user',
      'password: secret-password',
      'defaults:',
      '  projectKey: BZ',
      '  issueType: Story',
      'fields:',
      '  storyPoints: customfield_10016'
    ].join('\n'), 'utf8');

    const config = await getJiraConfig({ baizeRoot });
    const publicConfig = await getPublicJiraConfig({ baizeRoot });

    expect(config.password).toBe('secret-password');
    expect(publicConfig).toEqual({
      enabled: true,
      baseURL: 'http://127.0.0.1:8080',
      deploymentType: 'server',
      apiVersion: '2',
      authType: 'basic',
      credentialConfigured: true,
      defaultProjectKey: 'BZ',
      defaultIssueType: 'Story',
      fieldMappings: { storyPoints: 'customfield_10016' },
      fieldMappingsConfigured: true
    });
    expect(JSON.stringify(publicConfig)).not.toContain('secret-password');
  });
});
