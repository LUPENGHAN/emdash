import type { HostDependencyView } from '@emdash/core/services/host-dependencies/node';
import { ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentReleaseForDisplay, clearAgentRelease, peekAgentRelease } from './agent-release';
import { createAgentOperations } from './controller';

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

const runRuntimeLiveJob = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execState.execFile,
}));

vi.mock('@core/services/runtime-clients/node/live-job', () => ({
  runRuntimeLiveJob,
}));

function agentView(path: string | null): HostDependencyView {
  return {
    definition: { id: 'claude', category: 'agent' },
    status: 'available',
    selection: null,
    candidates: [],
    resolved: path
      ? { id: 'claude', command: 'claude', path, realpath: path, source: { kind: 'auto' } }
      : null,
    installOptions: [],
  } as HostDependencyView;
}

function managerFor(view: HostDependencyView) {
  return {
    snapshot: {
      state: () => ({
        snapshot: async () => ({ data: { dependencies: { claude: view } } }),
      }),
    },
  } as never;
}

function operations() {
  return createAgentOperations({
    ensureAgentDependenciesProbed: vi.fn(),
    getDependencyManager: vi.fn(),
    providerOverrideSettings: {} as never,
  });
}

describe('local installation version', () => {
  beforeEach(() => {
    execState.reset();
    runRuntimeLiveJob.mockReset();
    clearAgentRelease('claude');
    vi.stubGlobal('fetch', vi.fn());
  });

  it('lists a local version from --version and does not apply that cache to a remote host', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.2.0\n', stderr: '' }));
    const view = agentView('/usr/local/bin/claude');
    const listed = await operations().listAgentInstallationStatus(undefined, managerFor(view));

    expect(listed.find((status) => status.id === 'claude')).toMatchObject({ version: '1.2.0' });
    expect(execState.calls[0]?.args).toEqual(['--version']);
    expect(fetch).not.toHaveBeenCalled();

    execState.reset();
    const remote = await operations().listAgentInstallationStatus('remote-1', managerFor(view));
    expect(remote.find((status) => status.id === 'claude')?.version).toBeNull();
    expect(execState.calls).toHaveLength(0);
    expect(peekAgentRelease('claude')?.version).toBe('1.2.0');
  });

  it('keeps a missing binary as success with a null version', async () => {
    execState.setImpl(async () => {
      throw Object.assign(new Error('spawn ENOENT'), { stdout: '', stderr: '', code: 'ENOENT' });
    });
    const listed = await operations().listAgentInstallationStatus(
      undefined,
      managerFor(agentView('/missing/claude'))
    );

    expect(listed.find((status) => status.id === 'claude')).toMatchObject({ version: null });
    expect(execState.calls[0]?.args).toEqual(['--version']);
  });

  it('clears the cache and re-probes the installed command after a local install', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await agentReleaseForDisplay('claude', '/usr/local/bin/claude');
    execState.reset();
    execState.setImpl(async () => ({ stdout: 'claude 1.2.0\n', stderr: '' }));
    runRuntimeLiveJob.mockResolvedValue(ok(agentView('/usr/local/bin/claude')));

    const result = await operations().install(
      'claude',
      undefined,
      'npm',
      false,
      managerFor(agentView('/usr/local/bin/claude'))
    );

    expect(result).toMatchObject({
      success: true,
      data: { version: '1.2.0', command: '/usr/local/bin/claude' },
    });
    expect(execState.calls).toEqual([
      expect.objectContaining({
        file: '/usr/local/bin/claude',
        args: ['--version'],
      }),
    ]);
  });

  it('clears the cache without spawning when the installed command is null', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await agentReleaseForDisplay('claude', '/usr/local/bin/claude');
    execState.reset();
    runRuntimeLiveJob.mockResolvedValue(ok(agentView(null)));

    const result = await operations().update(
      'claude',
      undefined,
      undefined,
      undefined,
      managerFor(agentView(null))
    );

    expect(result).toMatchObject({ success: true, data: { version: null, command: null } });
    expect(execState.calls).toHaveLength(0);
    expect(peekAgentRelease('claude')).toBeUndefined();
  });

  it('does not probe --version for an install on a remote connection', async () => {
    execState.setImpl(async () => ({ stdout: 'claude 1.0.0\n', stderr: '' }));
    await agentReleaseForDisplay('claude', '/usr/local/bin/claude');
    execState.reset();
    runRuntimeLiveJob.mockResolvedValue(ok(agentView('/remote/bin/claude')));

    const result = await operations().install(
      'claude',
      'remote-1',
      'npm',
      false,
      managerFor(agentView('/remote/bin/claude'))
    );

    expect(result).toMatchObject({ success: true, data: { version: null } });
    expect(execState.calls).toHaveLength(0);
    expect(peekAgentRelease('claude')?.version).toBe('1.0.0');
  });
});
