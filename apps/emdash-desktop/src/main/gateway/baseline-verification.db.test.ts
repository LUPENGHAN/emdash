import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { toChildProcessLaunch } from '@emdash/core/primitives/exec/node';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { gitContract } from '@emdash/core/runtimes/git/api';
import { createGitController, GitRuntime } from '@emdash/core/runtimes/git/node';
import { scriptsContract } from '@emdash/core/runtimes/scripts/api';
import { ScriptsRuntime } from '@emdash/core/runtimes/scripts/node';
import { workspaceRegistryContract } from '@emdash/core/runtimes/workspace-registry/api';
import {
  createWorkspaceRegistryController,
  workspaceRegistryStore,
  WorkspaceRegistryRuntime,
} from '@emdash/core/runtimes/workspace-registry/node';
import { LocalAttachmentStore } from '@emdash/core/services/attachments/node';
import type {
  PtyExitInfo,
  PtyProcess,
  PtySpawner,
  PtySpawnSpec,
} from '@emdash/core/services/pty/api';
import { ok } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { createController } from '@emdash/wire/rpc';
import { cell } from '@emdash/wire/state';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectAttachmentState } from '@core/features/projects/api/attachments';
import {
  projectBaselineAttemptSchema,
  type BaselineVerification,
} from '@core/features/projects/api/baseline-sync';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';
import { createBackendBaselineVerification } from '@core/features/projects/node/backend-baseline-verification';

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

/** Executes the real Scripts spawn specification without depending on Electron's native PTY ABI. */
class ShellSpawner implements PtySpawner {
  readonly paths: string[] = [];
  spawn(spec: PtySpawnSpec): PtyProcess {
    this.paths.push(spec.cwd);
    const launch = toChildProcessLaunch(spec.invocation);
    const child = spawn(launch.executable, launch.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    const data: ((text: string) => void)[] = [];
    const exits: ((value: PtyExitInfo) => void)[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      for (const handler of data) handler(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const handler of data) handler(chunk.toString());
    });
    child.on('close', (exitCode) => {
      for (const handler of exits) handler({ exitCode, signal: null });
    });
    child.on('error', () => {
      for (const handler of exits) handler({ exitCode: 1, signal: null });
    });
    return {
      write: () => {},
      resize: () => {},
      kill: () => {
        child.kill('SIGTERM');
      },
      onData: (handler) => {
        data.push(handler);
      },
      onExit: (handler) => {
        exits.push(handler);
      },
      getPid: () => child.pid ?? -1,
    };
  }
}

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'emdash-baseline-executor-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const git = async (...args: string[]) =>
    (await execute('git', args, { cwd: repo })).stdout.trim();
  await git('init', '-b', 'develop');
  await git('config', 'user.name', 'Verification test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'version.txt'), 'baseline');
  await writeFile(
    join(repo, '.emdash.json'),
    JSON.stringify({
      scripts: {
        prepare: 'exit 71',
        setup: 'exit 72',
        run: 'exit 73',
        teardown: 'exit 74',
      },
    })
  );
  await git('add', '.');
  await git('commit', '-m', 'Baseline');
  const oid = await git('rev-parse', 'HEAD');
  await git('branch', 'task/keep');
  await git('branch', 'emdash/manage/keep');
  await writeFile(join(repo, 'version.txt'), 'root-is-newer');
  await git('commit', '-am', 'Advance root checkout');
  const rootOid = await git('rev-parse', 'HEAD');
  const handle = await workspaceRegistryStore.openTemp();
  cleanup.push(async () => handle.close());
  const registry = new WorkspaceRegistryRuntime({
    handle,
    attachments: new LocalAttachmentStore(join(dir, 'attachments')),
  });
  cleanup.push(async () => registry.dispose());
  const registryWire = createTestWire(
    workspaceRegistryContract,
    createWorkspaceRegistryController(registry)
  );
  cleanup.push(async () => registryWire.dispose());
  expect(
    (await registryWire.client.createWorkspace({ workspaceId: 'root', path: repo })).success
  ).toBe(true);
  const gitRuntime = new GitRuntime({
    watcher: {
      watch: () => ({ ready: async () => ok(undefined), release: async () => {} }),
      dispose: async () => {},
    },
  });
  cleanup.push(() => gitRuntime.dispose());
  const gitWire = createTestWire(gitContract, createGitController(gitRuntime));
  cleanup.push(async () => gitWire.dispose());
  const spawner = new ShellSpawner();
  const scripts = new ScriptsRuntime({
    spawner,
    userEnv: async () => ({ PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/sh' }),
    portProbe: async () => false,
  });
  cleanup.push(async () => scripts.dispose());
  const scriptsWire = createTestWire(
    scriptsContract,
    createController(scriptsContract, {
      runs: scripts.runsHost,
      devServers: scripts.devServersHost,
      output: (key) => scripts.outputLog(key),
      start: (input) => scripts.start(input),
      wait: (input) => scripts.wait(input),
      stop: (input) => scripts.stop(input),
      sendInput: (input) => scripts.sendInput(input),
      resize: (input) => scripts.resize(input),
    })
  );
  cleanup.push(async () => scriptsWire.dispose());
  const provider = {
    projectId: 'sdk',
    project: { id: 'sdk', repositoryWorkspaceId: 'root' },
    host: LOCAL_HOST_REF,
    repoPath: repo,
    workspaceRegistry: registryWire.client,
    git: gitWire.client,
  } as unknown as ProjectProvider;
  const scope = createScope({ label: 'baseline-executor-integration' });
  cleanup.push(() => scope.dispose());
  const track = vi.fn(() =>
    cell<ProjectAttachmentState>({ kind: 'attached', establishedHostGeneration: 1 })
  );
  const wait = vi.fn(scriptsWire.client.wait);
  const deps = {
    scope,
    projects: { track, requireAttached: () => ok(provider) } as unknown as ProjectAttachmentManager,
    placement: { resolveWorktreePool: async () => ok(join(dir, 'checks')) },
    runtimes: {
      client: async () => ok({ scripts: { ...scriptsWire.client, wait } }),
    } as unknown as Parameters<typeof createBackendBaselineVerification>[0]['runtimes'],
  };
  const attempt = projectBaselineAttemptSchema.parse({
    id: 'pinned-check',
    revision: 1,
    trigger: 'manual',
    startedAt: Date.now(),
    phase: 'verifying',
    target: {
      projectId: 'sdk',
      repositoryKey: repo,
      workspaceId: 'root',
      host: LOCAL_HOST_REF,
      checkout: repo,
      baselineRef: 'refs/heads/develop',
      remote: null,
      upstreamRef: null,
    },
    observation: { kind: 'local', beforeOid: oid, oid, upstreamOid: null, remoteFingerprint: null },
    verificationConfig: {
      command: 'test "$(cat version.txt)" = baseline && printf verified',
      timeoutMs: 5000,
    },
  });
  const receipts: BaselineVerification[] = [];
  const save = async (value: BaselineVerification) => {
    receipts.push(structuredClone(value));
  };
  return {
    factory: () => createBackendBaselineVerification(deps),
    attempt,
    receipts,
    save,
    git,
    rootOid,
    oid,
    repo,
    spawner,
    track,
    wait,
    registryWire,
    scripts,
  };
}

it('executes the configured command in a real pinned worktree without running project lifecycle commands', async () => {
  const t = await setup();
  const result = await t.factory().verify(t.attempt, t.save);
  expect(result).toMatchObject({ status: 'succeeded', exitCode: 0, output: 'verified' });
  expect(t.spawner.paths).toEqual([result.workspacePath]);
  expect(await t.git('rev-parse', 'develop')).toBe(t.rootOid);
  expect(await t.git('rev-parse', 'task/keep')).toBe(t.oid);
  expect(await t.git('rev-parse', 'emdash/manage/keep')).toBe(t.oid);
  expect(
    (await t.factory().recoverVerification({ ...t.attempt, verification: t.receipts.at(-1) }))
      .status
  ).toBe('succeeded');
  expect(t.spawner.paths).toHaveLength(1);
});

it('recovers the real retained run when the desktop lost its completion response', async () => {
  const t = await setup();
  const wait = t.wait.getMockImplementation();
  if (!wait) throw new Error('Missing wait implementation');
  t.wait.mockImplementationOnce(async (...args) => {
    await wait(...args);
    throw new Error('Lost completion response');
  });
  await expect(t.factory().verify(t.attempt, t.save)).rejects.toThrow('Lost completion response');
  const result = await t
    .factory()
    .recoverVerification({ ...t.attempt, verification: t.receipts.at(-1) });
  expect(result).toMatchObject({ status: 'succeeded', output: 'verified' });
  expect(t.spawner.paths).toHaveLength(1);
});

it('preserves a real nonzero command result and does not rerun it on recovery', async () => {
  const t = await setup();
  t.attempt.verificationConfig = { command: 'printf failure-evidence; exit 9', timeoutMs: 5000 };
  expect(await t.factory().verify(t.attempt, t.save)).toMatchObject({
    status: 'failed',
    exitCode: 9,
    output: 'failure-evidence',
  });
  expect(
    await t.factory().recoverVerification({ ...t.attempt, verification: t.receipts.at(-1) })
  ).toMatchObject({ status: 'failed', exitCode: 9 });
  expect(t.spawner.paths).toHaveLength(1);
});

it('retains a real script timeout as failed verification', async () => {
  const t = await setup();
  t.attempt.verificationConfig = { command: 'exec sleep 10', timeoutMs: 30 };
  const result = await t.factory().verify(t.attempt, t.save);
  expect(result).toMatchObject({ status: 'failed' });
  expect(result.message).toMatch(/timed out|timed-out/i);
  expect(t.spawner.paths).toHaveLength(1);
});
