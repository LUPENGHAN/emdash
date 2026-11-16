import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { gitContract } from '@emdash/core/runtimes/git/api';
import { createGitController, GitRuntime } from '@emdash/core/runtimes/git/node';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import { ok } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { client, connect, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { cell } from '@emdash/wire/state';
import { openFixture } from '@tooling/utils/db';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { ProjectAttachmentState } from '@core/features/projects/api/attachments';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';
import { createBackendTaskPullRequests } from '@core/features/source-control/node/backend-task-pull-requests';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { projects, tasks } from '@core/services/app-db/node/schema';
import type { PullRequestsRuntimeClient } from '@core/services/pull-requests/api/client';

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const scope = createScope({ label: 'task-pr-test' });
  cleanups.push(() => scope.dispose());
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'emdash-task-pr-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const fixture = await openFixture('baseline');
  cleanups.push(async () => fixture.close());
  const [project] = await fixture.db.select().from(projects).limit(1);
  const repo = join(dir, 'repo');
  const checkout = join(dir, 'code');
  const fork = join(dir, 'fork.git');
  await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout.trim();
  await git('init', '-b', 'develop');
  await git('config', 'user.name', 'Task PR test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'README.md'), 'baseline');
  await git('add', '.');
  await git('commit', '-m', 'Baseline');
  const baseline = await git('rev-parse', 'HEAD');
  await git('init', '--bare', fork);
  await git('worktree', 'add', '-b', 'feat/sdk', checkout, 'HEAD');
  await writeFile(join(checkout, 'sdk.ts'), 'export const version = 2;');
  await exec('git', ['add', '.'], { cwd: checkout });
  await exec('git', ['commit', '-m', 'Implement SDK'], { cwd: checkout });
  const oid = (await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
  // A fixture-only SSH executable maps this one logical fork to a local bare repository.
  // Git still performs its real receive-pack/ref update through the Host Wire job.
  const ssh = join(dir, 'fixture-ssh');
  const transfers = join(dir, 'transfers.txt');
  await writeFile(
    ssh,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const command = args.at(-1);
if (!args.includes('git@fixture.invalid') || !["git-receive-pack 'personal/sdk.git'", "git-upload-pack 'personal/sdk.git'"].includes(command)) process.exit(42);
require('node:fs').appendFileSync(${JSON.stringify(transfers)}, command + '\\n');
const result = spawnSync(command.startsWith('git-upload-pack') ? 'git-upload-pack' : 'git-receive-pack', [${JSON.stringify(fork)}], { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );
  await git('config', 'core.sshCommand', `'${ssh.replaceAll("'", "'\\''")}'`);
  await git('config', 'ssh.variant', 'simple');
  await git('remote', 'add', 'personal', 'git@fixture.invalid:personal/sdk.git');
  await git('remote', 'add', 'upstream', 'git@fixture.invalid:org/sdk.git');
  await fixture.db.insert(workspaces).values({
    id: 'pr-workspace',
    type: 'local',
    location: 'local',
    kind: 'worktree',
    path: checkout,
    config: {
      version: '2',
      workspace: { kind: 'new-worktree' },
      git: {
        kind: 'create-branch',
        branchName: 'feat/sdk',
        fromBranch: { type: 'local', branch: 'develop' },
      },
    },
  });
  await fixture.db.insert(tasks).values([
    {
      id: 'pr-worker',
      projectId: project.id,
      workspaceId: 'pr-workspace',
      name: 'SDK',
      status: 'in_progress',
    },
    {
      id: 'pr-main',
      projectId: project.id,
      name: 'Main',
      type: 'coordination',
      status: 'in_progress',
    },
    {
      id: 'pr-replacement',
      projectId: project.id,
      name: 'Replacement',
      type: 'coordination',
      status: 'in_progress',
    },
  ]);
  const runtime = new GitRuntime({
    watcher: {
      watch: () => ({ ready: async () => ok(undefined), release: async () => {} }),
      dispose: async () => {},
    },
  });
  const transport = memoryTransportPair();
  const controller = createGitController(runtime);
  const stop = serve(transport.right, controller);
  cleanups.push(async () => {
    stop();
    await controller.dispose?.();
    await runtime.dispose();
  });
  const hostGit = client(gitContract, connect(transport.left));
  const facts = {
    remotes: [
      {
        name: 'personal',
        url: 'git@fixture.invalid:personal/sdk.git',
        host: 'fixture.invalid',
        headBranch: 'develop',
        branches: ['develop'],
      },
      {
        name: 'upstream',
        url: 'git@fixture.invalid:org/sdk.git',
        host: 'fixture.invalid',
        headBranch: 'develop',
        branches: ['develop'],
      },
    ],
    localBranches: ['develop', 'feat/sdk'],
  };
  const provider = {
    repository: { repository: hostPathFromNative(repo) },
    git: hostGit,
    settings: {
      getStoredGitSettings: async () => ({
        pushRemote: 'personal',
        baseRemote: 'upstream',
        defaultBranch: { remote: 'upstream', branch: 'develop' },
      }),
      getPlacementContext: async () => ({ builtInWorktreeRoot: dir, homeDirectory: dir }),
    },
    repoFacts: { get: async () => facts },
  } as unknown as ProjectProvider;
  let owner = 'pr-main';
  const authorize = vi.fn(
    async (caller: AgentCaller, target: { id: string }) =>
      caller.taskId === target.id || caller.taskId === owner
  );
  const registered = vi.fn(async () => ok(undefined));
  const ensure = vi.fn(async () =>
    ok({ url: 'https://fixture.invalid/org/sdk/pull/7', number: 7 })
  );
  const release = vi.fn();
  const credentials = vi.fn(async () => ({ credentials: undefined, release }));
  const attachment = cell<ProjectAttachmentState>({ kind: 'absent' });
  const track = vi.fn((_projectId: string) => {
    attachment.set({ kind: 'attached', establishedHostGeneration: 1 });
    return attachment;
  });
  const deps: Parameters<typeof createBackendTaskPullRequests>[0] = {
    db: fixture.db,
    scope,
    projects: { track, requireAttached: () => ok(provider) } as unknown as ProjectAttachmentManager,
    workspaceIdentity: {
      resolve: async (id) =>
        id === 'pr-workspace'
          ? { workspaceId: id, projectId: project.id, host: LOCAL_HOST_REF, path: checkout }
          : null,
      resolveProject: async () => null,
    },
    // Only the Git runtime is used by this adapter.
    runtimes: { client: async () => ok({ git: hostGit } as HostRuntimesClient) },
    credentials: { mintOperationCredentials: credentials } as unknown as Parameters<
      typeof createBackendTaskPullRequests
    >[0]['credentials'],
    pullRequests: async () =>
      ({
        registerRepository: registered,
        ensurePullRequest: ensure,
      }) as unknown as PullRequestsRuntimeClient,
    refreshRepositoryInterest: vi.fn(async () => {}),
    access: { mayAccessTask: authorize },
    assertCaller: vi.fn(async () => {}),
  };
  const caller: AgentCaller = {
    taskId: 'pr-main',
    conversationId: 'main-session',
    projectId: project.id,
    providerId: 'opencode',
    title: 'Main',
    cwd: null,
  };
  const input = { taskId: 'pr-worker', requestId: 'pr-1', title: 'SDK change', draft: false };
  return {
    deps,
    service: () => createBackendTaskPullRequests(deps),
    caller,
    input,
    git,
    hostGit,
    checkout,
    fork,
    oid,
    baseline,
    ensure,
    registered,
    credentials,
    release,
    transfers,
    attachment,
    track,
    fixture,
    owner: (id: string) => {
      owner = id;
    },
  };
}

it('pushes exactly the frozen task commit, targets the configured organization branch and recovers after takeover', async () => {
  const t = await setup();
  const prepared = await t.service().prepare(t.input, t.caller);
  expect(prepared.plan).toMatchObject({
    sourceRef: 'refs/heads/feat/sdk',
    oid: t.oid,
    repositoryUrl: 'https://fixture.invalid/org/sdk',
    headRepositoryUrl: 'https://fixture.invalid/personal/sdk',
    base: 'develop',
    pushTarget: { remote: 'personal' },
  });
  expect(t.credentials).not.toHaveBeenCalled();
  t.ensure.mockRejectedValueOnce(new Error('Lost platform response'));
  await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
    'Lost platform response'
  );
  expect(t.credentials).toHaveBeenCalledTimes(2);
  expect(t.release).toHaveBeenCalledTimes(2);
  expect(
    (await exec('git', ['--git-dir', t.fork, 'rev-parse', 'refs/heads/feat/sdk'])).stdout.trim()
  ).toBe(t.oid);
  expect(
    (await exec('git', ['--git-dir', t.fork, 'for-each-ref', '--format=%(refname)'])).stdout.trim()
  ).toBe('refs/heads/feat/sdk');
  expect(await t.git('rev-parse', 'develop')).toBe(t.baseline);
  t.owner('pr-replacement');
  await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
    'current responsible'
  );
  const result = await t.service().run(t.input.taskId, t.input.requestId, {
    ...t.caller,
    taskId: 'pr-replacement',
    conversationId: 'replacement-session',
  });
  expect(result.phase).toBe('complete');
  expect(result.plan).toEqual(prepared.plan);
  expect(t.ensure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      repositoryUrl: 'https://fixture.invalid/org/sdk',
      head: 'feat/sdk',
      base: 'develop',
    })
  );
  expect(t.credentials).toHaveBeenCalledTimes(3);
  expect(t.release).toHaveBeenCalledTimes(3);
});

it('retains a background project attachment for prepare and restores it for saved-request execution', async () => {
  const t = await setup();
  const service = t.service();
  expect(t.track).not.toHaveBeenCalled();
  await service.prepare(t.input, t.caller);
  expect(t.track).toHaveBeenCalledOnce();
  expect(t.track.mock.calls[0]?.[0]).toBe(t.caller.projectId);
  t.attachment.set({ kind: 'absent' });
  const restored = t.service();
  expect((await restored.run(t.input.taskId, t.input.requestId, t.caller)).phase).toBe('complete');
  expect(t.track).toHaveBeenCalledTimes(2);
  expect(t.ensure).toHaveBeenCalledOnce();
});

it('prepares the actual commit when the live HEAD projection has not observed an agent commit', async () => {
  const t = await setup();
  const selector = { checkout: hostPathFromNative(t.checkout) };
  const state = t.hostGit.checkout.model.state(selector, 'head');
  const before = await state.snapshot();
  await writeFile(join(t.checkout, 'committed-by-agent.ts'), 'export const changed = true;');
  await exec('git', ['add', '.'], { cwd: t.checkout });
  await exec('git', ['commit', '-m', 'Agent commit'], { cwd: t.checkout });
  const oid = (await exec('git', ['rev-parse', 'HEAD'], { cwd: t.checkout })).stdout.trim();
  // This fixture has no filesystem watch notifications, so the projection stays cached.
  expect((await state.snapshot()).data).toEqual(before.data);
  const service = t.service();
  expect((await service.prepare(t.input, t.caller)).plan.oid).toBe(oid);
  expect((await service.run(t.input.taskId, t.input.requestId, t.caller)).phase).toBe('complete');
  expect(
    (await exec('git', ['--git-dir', t.fork, 'rev-parse', 'refs/heads/feat/sdk'])).stdout.trim()
  ).toBe(oid);
});

it('creates from the pinned remote commit without publishing local commits, including later local work', async () => {
  const t = await setup();
  await t.git('push', t.fork, 'develop:refs/heads/feat/sdk');
  const prepared = await t.service().prepare({ ...t.input, push: false }, t.caller);
  expect(prepared.plan).toMatchObject({ oid: t.baseline, push: false });
  expect(prepared.plan.oid).not.toBe(t.oid);
  await writeFile(join(t.checkout, 'local-only.ts'), 'export const local = true;');
  await exec('git', ['add', '.'], { cwd: t.checkout });
  await exec('git', ['commit', '-m', 'Keep local work'], { cwd: t.checkout });
  const local = (await exec('git', ['rev-parse', 'HEAD'], { cwd: t.checkout })).stdout.trim();
  expect((await t.service().run(t.input.taskId, t.input.requestId, t.caller)).phase).toBe(
    'complete'
  );
  expect(
    (await exec('git', ['--git-dir', t.fork, 'rev-parse', 'refs/heads/feat/sdk'])).stdout.trim()
  ).toBe(t.baseline);
  expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: t.checkout })).stdout.trim()).toBe(local);
  expect(await readFile(t.transfers, 'utf8')).not.toContain('git-receive-pack');
  expect(t.ensure).toHaveBeenCalledOnce();
});

it('refuses a changed remote commit without pushing or calling the platform', async () => {
  const t = await setup();
  await t.git('push', t.fork, 'develop:refs/heads/feat/sdk');
  await t.service().prepare({ ...t.input, push: false }, t.caller);
  await exec('git', ['--git-dir', t.fork, 'fetch', t.checkout, 'feat/sdk']);
  await exec('git', ['--git-dir', t.fork, 'update-ref', 'refs/heads/feat/sdk', t.oid]);
  await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
    'published source commit changed'
  );
  expect(await readFile(t.transfers, 'utf8')).not.toContain('git-receive-pack');
  expect(t.ensure).not.toHaveBeenCalled();
});

it('does not create an unpublished branch when the user chose to skip push', async () => {
  const t = await setup();
  await expect(t.service().prepare({ ...t.input, push: false }, t.caller)).rejects.toThrow(
    'not published'
  );
  expect(await readFile(t.transfers, 'utf8')).not.toContain('git-receive-pack');
  expect(t.ensure).not.toHaveBeenCalled();
});

it('stops a stale remote before minting credentials or creating a PR', async () => {
  const t = await setup();
  await t.service().prepare(t.input, t.caller);
  await t.git('remote', 'set-url', 'personal', 'git@fixture.invalid:other/sdk.git');
  await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
    'pinned push destination'
  );
  expect(t.credentials).not.toHaveBeenCalled();
  expect(t.ensure).not.toHaveBeenCalled();
});

it('refuses another task agent even when its project grant permits general task control', async () => {
  const t = await setup();
  t.deps.access.mayAccessTask = async () => true;
  await expect(
    t.service().prepare(t.input, { ...t.caller, taskId: 'foreign-worker' })
  ).rejects.toThrow('only for its own task');
  const own = await t.service().prepare(t.input, { ...t.caller, taskId: t.input.taskId });
  expect(own.phase).toBe('prepared');
});

it('rejects management tasks and inactive calling sessions before remote access', async () => {
  const t = await setup();
  await expect(t.service().prepare({ ...t.input, taskId: 'pr-main' }, t.caller)).rejects.toThrow(
    'unavailable'
  );
  vi.mocked(t.deps.assertCaller).mockRejectedValue(new Error('Inactive caller'));
  await expect(t.service().prepare(t.input, t.caller)).rejects.toThrow('Inactive caller');
  expect(t.credentials).not.toHaveBeenCalled();
  expect(t.ensure).not.toHaveBeenCalled();
});

it('allows main-agent status reads without requiring a code workspace', async () => {
  const t = await setup();
  expect(await t.service().list('pr-main', t.caller)).toEqual([]);
  expect(t.credentials).not.toHaveBeenCalled();
  expect(t.ensure).not.toHaveBeenCalled();
});
