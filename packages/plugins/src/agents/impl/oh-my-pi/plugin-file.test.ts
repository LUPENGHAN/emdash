import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

function createMemoryFs(): PluginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async delete(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(path) {
      return [...files.keys()].filter((file) => file.startsWith(path));
    },
  };
}

describe('oh-my-pi plugin hooks', () => {
  it('resolves the OMP agent directory from its documented environment hierarchy', () => {
    const resolveConfigRoot = provider.behavior.plugins?.resolveConfigRoot;
    expect(resolveConfigRoot).toBeDefined();

    expect(resolveConfigRoot?.({ env: {}, homeDir: '/home/ada', platform: 'linux' })).toBe(
      '/home/ada/.omp/agent'
    );
    expect(
      resolveConfigRoot?.({
        env: { PI_CONFIG_DIR: '.custom-omp' },
        homeDir: '/home/ada',
        platform: 'linux',
      })
    ).toBe('/home/ada/.custom-omp/agent');
    expect(
      resolveConfigRoot?.({
        env: {
          PI_CODING_AGENT_DIR: '/configs/omp-agent',
          PI_CONFIG_DIR: '.ignored',
        },
        homeDir: '/home/ada',
        platform: 'linux',
      })
    ).toBe('/configs/omp-agent');
  });

  it('installs an OMP extension that reports turn completion from session_stop', async () => {
    const fs = createMemoryFs();

    const written = await provider.behavior.plugins?.installPlugin(fs, { kind: 'global' });

    expect(written).toEqual(['extensions/emdash-hook.ts']);
    const content = await fs.read('extensions/emdash-hook.ts');
    expect(content).toContain("pi.on('session_stop'");
    // The session id, which `omp acp` loads (not the file path).
    expect(content).toContain('getSessionId?.()');
    expect(content).not.toContain('providerSessionId: event.session_file');
    expect(content).toContain("notifyEmdash('stop'");
    expect(content).toContain("pi.on('session_shutdown', async ()");
  });
});

describe('oh-my-pi chat sessions', () => {
  it('recognizes the missing-session error of omp acp', () => {
    const check = provider.behavior.acp?.isSessionNotFound;
    const error = {
      code: -32603,
      message: 'Internal error',
      data: { details: 'ACP session not found: 01a0efbd' },
    };
    expect(check?.(error, '01a0efbd')).toBe(true);
    expect(check?.(error, 'other')).toBe(false);
    expect(check?.({ code: -32603, message: 'Internal error' }, '01a0efbd')).toBe(false);
  });
});
