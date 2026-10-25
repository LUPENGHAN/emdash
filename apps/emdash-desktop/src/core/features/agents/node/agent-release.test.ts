import type { CLIAgentPluginProvider } from '@emdash/core/services/agent-plugins/api/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentUpdateActionState } from '@core/features/agents/api/browser/components/agent-selector/agent-install';
import type { Installation } from '@core/primitives/agents/api';
import { resolveActiveInstallation } from '@core/primitives/agents/api';
import {
  agentReleaseForDisplay,
  applyAgentRelease,
  clearAgentRelease,
  compareVersions,
  githubRepoFromProvider,
  isNewerVersion,
  loadAgentRelease,
  npmPackageFromCommand,
  npmPackageFromProvider,
  parseVersion,
  peekAgentRelease,
} from './agent-release';

const execState = vi.hoisted(() => {
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
  let impl: (
    file: string,
    args: readonly string[]
  ) => Promise<{ stdout: string; stderr: string }> = async () => ({ stdout: '', stderr: '' });
  const custom = Symbol.for('nodejs.util.promisify.custom');
  function execFile(
    file: string,
    args: readonly string[],
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void
  ) {
    const cb = typeof options === 'function' ? (options as typeof callback) : callback;
    calls.push({ file, args, options: typeof options === 'function' ? undefined : options });
    void impl(file, args).then(
      (out) => cb?.(null, out.stdout, out.stderr),
      (error: Error) => cb?.(error, '', '')
    );
  }
  Object.assign(execFile, {
    [custom](file: string, args: readonly string[], options: unknown) {
      calls.push({ file, args, options });
      return impl(file, args);
    },
  });
  return {
    execFile,
    calls,
    setImpl(next: typeof impl) {
      impl = next;
    },
    reset() {
      calls.length = 0;
      impl = async () => ({ stdout: '', stderr: '' });
    },
  };
});

vi.mock('node:child_process', () => ({
  execFile: execState.execFile,
}));

function installation(partial: Partial<Installation> = {}): Installation {
  return {
    id: '/usr/local/lib/node_modules/pkg/bin/agent',
    realpath: '/usr/local/lib/node_modules/pkg/bin/agent',
    pathEntry: '/usr/local/bin/agent',
    isActive: true,
    manageable: false,
    provenance: { kind: 'unknown', confidence: 'inferred' },
    status: 'available',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    ...partial,
  };
}

describe('agent release parsing', () => {
  it('reads a version out of a --version line', () => {
    expect(parseVersion('claude 2.1.140 (Claude Code)')).toBe('2.1.140');
    expect(parseVersion('no version here')).toBeNull();
    expect(parseVersion('v18.12.6')).toBe('18.12.6');
    expect(isNewerVersion('18.12.6', '18.11.1')).toBe(true);
    expect(isNewerVersion('v18.12.6', '18.12.6')).toBe(false);
  });

  it('hides the update action when the latest version is unknown', () => {
    expect(isNewerVersion(null, '2.1.310')).toBe(false);
    expect(
      getAgentUpdateActionState({
        updateAvailable: false,
        updateStrategyKind: 'cli',
        version: '2.1.310',
        latestVersion: null,
        isUpdating: false,
      }).render
    ).toBe(false);
    expect(
      getAgentUpdateActionState({
        updateAvailable: false,
        updateStrategyKind: 'package-manager',
        version: '1.0.0',
        latestVersion: null,
        isUpdating: false,
      }).render
    ).toBe(false);
  });

  it('treats a higher latest version as an update', () => {
    expect(isNewerVersion('2.2.0', '2.1.9')).toBe(true);
    expect(isNewerVersion('v1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion(null, '1.0.0')).toBe(false);
  });

  it('orders prereleases below their release', () => {
    expect(isNewerVersion('2.0.0', '2.0.0-beta.1')).toBe(true);
    expect(isNewerVersion('2.0.0-beta.1', '2.0.0')).toBe(false);
    expect(compareVersions('2.0.0-beta.2', '2.0.0-beta.10')).toBe(-1);
    expect(compareVersions('2.0.0-alpha', '2.0.0-beta')).toBe(-1);
    expect(compareVersions('2.0.0-1', '2.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('reads an npm package and a github repo off a plugin', () => {
    expect(npmPackageFromCommand('npm install -g @earendil-works/pi-coding-agent')).toBe(
      '@earendil-works/pi-coding-agent'
    );
    const provider = {
      capabilities: {
        hostDependency: {
          updates: { releaseSource: { kind: 'github', repo: 'can1357/oh-my-pi' } },
        },
      },
    } as unknown as CLIAgentPluginProvider;
    expect(githubRepoFromProvider(provider)).toBe('can1357/oh-my-pi');
  });
});

describe('applyAgentRelease', () => {
  const status = {
    installations: [installation()],
    version: '1.0.0',
    latestVersion: null,
    updateAvailable: false,
  };

  it('keeps the known version when --version failed', () => {
    const next = applyAgentRelease(status, {
      version: null,
      latestVersion: '1.1.0',
      method: null,
      versionCheckedAt: 0,
      checkedAt: 0,
    });
    expect(next).toMatchObject({ version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true });
    expect(next.installations[0]).toMatchObject({ version: '1.0.0', updateAvailable: true });
  });

  it('puts the probed version on the active installation, not the cached latest', () => {
    const next = applyAgentRelease(
      {
        installations: [installation({ isActive: true, latestVersion: '18.11.1' })],
        version: null,
        latestVersion: '18.11.1',
        updateAvailable: false,
      },
      {
        version: '18.12.6',
        latestVersion: '18.11.1',
        method: null,
        versionCheckedAt: 1,
        checkedAt: 1,
      }
    );
    expect(resolveActiveInstallation(next.installations, { kind: 'auto' })?.version).toBe(
      '18.12.6'
    );
    expect(next.updateAvailable).toBe(false);
  });

  it('applies an update method only where the install agrees with it', () => {
    const release = {
      version: '1.0.0',
      latestVersion: '1.1.0',
      method: 'npm' as const,
      versionCheckedAt: 0,
      checkedAt: 0,
    };
    expect(applyAgentRelease(status, release).installations[0]).toMatchObject({
      manageable: true,
      provenance: { kind: 'npm' },
    });
    const brewed = {
      ...status,
      installations: [installation({ realpath: '/opt/homebrew/Cellar/agent/1.0.0/bin/agent' })],
    };
    expect(applyAgentRelease(brewed, release).installations[0]).toMatchObject({
      manageable: false,
      provenance: { kind: 'unknown' },
    });
    const manual = {
      ...status,
      installations: [installation({ provenance: { kind: 'manual', confidence: 'confirmed' } })],
    };
    expect(applyAgentRelease(manual, release).installations[0]).toMatchObject({
      manageable: false,
      provenance: { kind: 'manual' },
    });
  });
});

const offlineProvider = {
  capabilities: { hostDependency: {} },
} as CLIAgentPluginProvider;

const githubProvider = {
  capabilities: {
    hostDependency: {
      updates: { releaseSource: { kind: 'github', repo: 'acme/claude' } },
    },
  },
} as CLIAgentPluginProvider;

describe('local agent version cache', () => {
  let now = 0;

  beforeEach(() => {
    now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    execState.reset();
    clearAgentRelease('claude');
    clearAgentRelease('codex');
    clearAgentRelease('muse');
    clearAgentRelease('continue');
    clearAgentRelease('grok');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('skips --version while the cached release is inside the TTL', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.2.0\n', stderr: '' }));

    await agentReleaseForDisplay('claude', '/bin/claude');
    await agentReleaseForDisplay('claude', '/bin/claude');

    expect(execState.calls).toHaveLength(1);
    expect(execState.calls[0]).toMatchObject({
      file: '/bin/claude',
      args: ['--version'],
      options: { timeout: 4000, windowsHide: true },
    });
    expect(Array.isArray(execState.calls[0]?.args)).toBe(true);
  });

  it('reads a fresh local version after the TTL without asking GitHub or npm', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await agentReleaseForDisplay('claude', '/bin/claude');

    now += 6 * 60 * 1000;
    execState.setImpl(async () => ({ stdout: 'claude 1.2.0\n', stderr: '' }));
    const release = await agentReleaseForDisplay('claude', '/bin/claude');

    expect(release?.version).toBe('1.2.0');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execState.calls).toHaveLength(2);
  });

  it('keeps the cached version when --version fails, and stores null after a clear', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await loadAgentRelease('claude', '/bin/claude', offlineProvider);

    now += 6 * 60 * 1000;
    execState.setImpl(async () => ({ stdout: 'no version here\n', stderr: '' }));
    await loadAgentRelease('claude', '/bin/claude', offlineProvider);
    expect(peekAgentRelease('claude')?.version).toBe('1.0.0');

    clearAgentRelease('claude');
    now += 6 * 60 * 1000;
    await loadAgentRelease('claude', '/bin/claude', offlineProvider);
    expect(peekAgentRelease('claude')?.version).toBeNull();
  });

  it('keeps a separate cache entry per agent id', async () => {
    execState.setImpl(async (file) => ({
      stdout: file.endsWith('codex') ? 'codex 2.0.0\n' : 'claude 1.0.0\n',
      stderr: '',
    }));
    await agentReleaseForDisplay('claude', '/bin/claude');
    await agentReleaseForDisplay('codex', '/bin/codex');

    clearAgentRelease('claude');

    expect(peekAgentRelease('claude')).toBeUndefined();
    expect(peekAgentRelease('codex')?.version).toBe('2.0.0');
  });

  it('runs one --version when two reads share an id', async () => {
    let resolveProbe: (value: { stdout: string; stderr: string }) => void = () => undefined;
    execState.setImpl(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
    );

    const first = agentReleaseForDisplay('claude', '/bin/claude');
    const second = agentReleaseForDisplay('claude', '/bin/claude');
    resolveProbe({ stdout: 'claude 1.2.0\n', stderr: '' });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { version: '1.2.0' },
      { version: '1.2.0' },
    ]);
    expect(execState.calls).toHaveLength(1);
  });

  it('does not write a cleared generation back into the cache', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await agentReleaseForDisplay('claude', '/bin/claude');

    now += 6 * 60 * 1000;
    let resolveProbe: (value: { stdout: string; stderr: string }) => void = () => undefined;
    execState.setImpl(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
    );
    const pending = agentReleaseForDisplay('claude', '/bin/claude');
    clearAgentRelease('claude');
    resolveProbe({ stdout: 'claude 1.0.0\n', stderr: '' });
    await pending;

    expect(peekAgentRelease('claude')).toBeUndefined();
  });

  it('does not wait on a GitHub lookup to show the local version', async () => {
    let finishFetch: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishFetch = resolve;
          })
      )
    );
    execState.setImpl(async () => ({ stdout: 'claude 1.2.0\n', stderr: '' }));
    const loading = loadAgentRelease('claude', '/bin/claude', githubProvider);

    const outcome = await Promise.race([
      agentReleaseForDisplay('claude', '/bin/claude').then((release) => release?.version),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ]);

    expect(outcome).toBe('1.2.0');
    finishFetch(new Response('{}', { status: 500 }));
    await loading;
  });

  it('does not spawn when the binary path is missing', async () => {
    await agentReleaseForDisplay('claude', null);
    expect(execState.calls).toHaveLength(0);
    expect(peekAgentRelease('claude')).toBeUndefined();
  });

  it('does not mark the latest version as checked when only --version ran', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '9.9.9' })));
    vi.stubGlobal('fetch', fetchMock);
    execState.setImpl(async () => ({ stdout: 'codex-cli 0.163.0\n', stderr: '' }));
    const npmProvider = {
      capabilities: {
        hostDependency: {
          installCommands: {
            macos: [{ command: 'npm install -g @openai/codex' }],
            linux: [{ command: 'npm install -g @openai/codex' }],
            windows: [{ command: 'npm install -g @openai/codex' }],
          },
        },
      },
    } as CLIAgentPluginProvider;

    const shown = await agentReleaseForDisplay('codex', '/bin/codex', npmProvider);

    expect(shown).toMatchObject({ version: '0.163.0', latestVersion: null, checkedAt: 0 });
    expect(shown?.versionCheckedAt).toBe(now);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://registry.npmjs.org/@openai%2fcodex/latest'
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('@latest');
    await vi.waitFor(() => expect(peekAgentRelease('codex')?.latestVersion).toBe('9.9.9'));
    expect(execState.calls).toHaveLength(1);
  });

  it('keeps the version timestamp when the release lookup reuses a fresh local version', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await agentReleaseForDisplay('claude', '/bin/claude');
    const versionCheckedAt = peekAgentRelease('claude')?.versionCheckedAt;
    const calls = execState.calls.length;

    await loadAgentRelease('claude', '/bin/claude', offlineProvider);

    expect(execState.calls).toHaveLength(calls);
    expect(peekAgentRelease('claude')).toMatchObject({
      version: '1.0.0',
      latestVersion: null,
      versionCheckedAt,
    });
    expect(peekAgentRelease('claude')?.checkedAt).toBe(now);
  });

  it('keeps the known version when a later --version has no parseable version', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ tag_name: 'v18.12.6' })));
    execState.setImpl(async () => ({ stdout: '2.1.310\n', stderr: '' }));
    await loadAgentRelease('claude', '/bin/claude', githubProvider);
    expect(peekAgentRelease('claude')).toMatchObject({
      version: '2.1.310',
      latestVersion: '18.12.6',
    });

    now += 6 * 60 * 1000;
    execState.setImpl(async () => ({ stdout: 'no version here\n', stderr: '' }));
    const shown = await agentReleaseForDisplay('claude', '/bin/claude');

    expect(shown).toMatchObject({ version: '2.1.310', latestVersion: '18.12.6' });
  });

  it('stores a null latest version when the release source is none', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    execState.setImpl(async () => ({ stdout: '1.0.0\n', stderr: '' }));
    const noneProvider = {
      capabilities: {
        hostDependency: {
          updates: { releaseSource: { kind: 'none' } },
          installCommands: {
            macos: [{ command: 'npm install -g should-not-run' }],
            linux: [{ command: 'npm install -g should-not-run' }],
            windows: [{ command: 'npm install -g should-not-run' }],
          },
        },
      },
    } as CLIAgentPluginProvider;

    await loadAgentRelease('muse', '/bin/muse', noneProvider);

    expect(peekAgentRelease('muse')).toMatchObject({ version: '1.0.0', latestVersion: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(npmPackageFromProvider(noneProvider)).toBeNull();
  });

  it('asks the named npm package and not the install command', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('continuedev')) {
        return new Response(JSON.stringify({ version: '1.5.47' }));
      }
      return new Response(JSON.stringify({ version: '1.0.70' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const continueProvider = {
      capabilities: {
        hostDependency: {
          updates: { releaseSource: { kind: 'npm', package: '@continuedev/cli' } },
          installCommands: { macos: [{ command: 'npm i -g @continuedev/cli' }] },
        },
      },
    } as CLIAgentPluginProvider;
    const grokProvider = {
      capabilities: {
        hostDependency: {
          updates: { releaseSource: { kind: 'npm', package: '@xai-official/grok' } },
          installCommands: {
            macos: [{ command: 'npm install -g @xai-official/grok@latest' }],
          },
        },
      },
    } as CLIAgentPluginProvider;

    await loadAgentRelease('continue', null, continueProvider);
    await loadAgentRelease('grok', null, grokProvider);

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://registry.npmjs.org/@continuedev%2fcli/latest',
      'https://registry.npmjs.org/@xai-official%2fgrok/latest',
    ]);
    expect(peekAgentRelease('continue')?.latestVersion).toBe('1.5.47');
    expect(peekAgentRelease('grok')?.latestVersion).toBe('1.0.70');
  });
});
