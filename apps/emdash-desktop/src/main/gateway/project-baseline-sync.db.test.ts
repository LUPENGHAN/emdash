import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { gitContract } from '@emdash/core/runtimes/git/api';
import { createGitController, GitRuntime } from '@emdash/core/runtimes/git/node';
import { ok } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { client, connect, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { cell } from '@emdash/wire/state';
import { openFixture } from '@tooling/utils/db';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectAttachmentState } from '@core/features/projects/api/attachments';
import type { BaselineVerification } from '@core/features/projects/api/baseline-sync';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';
import { createBackendProjectBaselineSync } from '@core/features/projects/node/backend-baseline-sync';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { projects } from '@core/services/app-db/node/schema';

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'emdash-project-baseline-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fixture = await openFixture('baseline');
  cleanup.push(async () => fixture.close());
  const [row] = await fixture.db.select().from(projects).limit(1);
  const scope = createScope({ label: 'project-baseline-test' });
  cleanup.push(() => scope.dispose());
  const source = join(dir, 'source');
  const repo = join(dir, 'repo');
  const upstream = join(dir, 'upstream.git');
  const offline = join(dir, 'offline');
  await mkdir(source);
  const git = async (cwd: string, ...args: string[]) =>
    (await execute('git', args, { cwd })).stdout.trim();
  await git(source, 'init', '-b', 'develop');
  await git(source, 'config', 'user.name', 'Baseline test');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'code.ts'), 'export const version = 1;');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'Baseline');
  await git(source, 'clone', '--bare', source, upstream);
  await git(source, 'clone', upstream, repo);
  const before = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'worktree', 'add', '-b', 'feature/task', join(dir, 'task'), 'HEAD');
  const ssh = join(dir, 'fixture-ssh');
  await writeFile(
    ssh,
    `#!/usr/bin/env node
const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (!args.includes('git@fixture.invalid') || args.at(-1) !== "git-upload-pack 'org/sdk.git'") process.exit(42);
if (fs.existsSync(${JSON.stringify(offline)})) { process.stderr.write('ssh: connect to host fixture.invalid port 22: Connection refused\\n'); process.exit(255); }
const result = spawnSync('git-upload-pack', [${JSON.stringify(upstream)}], { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );
  await git(repo, 'config', 'core.sshCommand', `'${ssh.replaceAll("'", "'\\''")}'`);
  await git(repo, 'config', 'ssh.variant', 'simple');
  await git(repo, 'remote', 'set-url', 'origin', 'git@fixture.invalid:org/sdk.git');
  const runtime = new GitRuntime({
    watcher: {
      watch: () => ({ ready: async () => ok(undefined), release: async () => {} }),
      dispose: async () => {},
    },
  });
  const pair = memoryTransportPair();
  const controller = createGitController(runtime);
  const stop = serve(pair.right, controller);
  cleanup.push(async () => {
    stop();
    await controller.dispose?.();
    await runtime.dispose();
  });
  const hostGit = client(gitContract, connect(pair.left));
  const provider = {
    projectId: row.id,
    project: { ...row, repositoryWorkspaceId: 'baseline-root' },
    host: LOCAL_HOST_REF,
    repoPath: repo,
    hasRepository: true,
    git: hostGit,
    repository: { repository: hostPathFromNative(repo) },
    settings: {
      getStoredGitSettings: async () => ({
        defaultBranch: { remote: 'origin', branch: 'develop' },
        baseRemote: 'origin',
      }),
      getPlacementContext: async () => ({ builtInWorktreeRoot: dir, homeDirectory: dir }),
    },
    repoFacts: {
      get: async () => ({
        localBranches: ['develop', 'feature/task'],
        remotes: [
          {
            name: 'origin',
            url: 'git@fixture.invalid:org/sdk.git',
            branches: ['develop'],
            headBranch: 'develop',
            host: 'fixture.invalid',
          },
        ],
      }),
    },
  } as unknown as ProjectProvider;
  const track = vi.fn(() =>
    cell<ProjectAttachmentState>({ kind: 'attached', establishedHostGeneration: 1 })
  );
  const release = vi.fn();
  const credentials = vi.fn(async () => ({ credentials: undefined, release }));
  const verify = vi.fn<
    Parameters<typeof createBackendProjectBaselineSync>[0]['verification']['verify']
  >(async () => ({ status: 'succeeded', exitCode: 0, output: 'Passed' }));
  const recoverVerification = vi.fn(
    async (): Promise<BaselineVerification> => ({ status: 'unknown', output: '' })
  );
  const deps: Parameters<typeof createBackendProjectBaselineSync>[0] = {
    db: fixture.db,
    scope,
    projects: { track, requireAttached: () => ok(provider) } as unknown as ProjectAttachmentManager,
    credentials: { mintOperationCredentials: credentials } as unknown as Parameters<
      typeof createBackendProjectBaselineSync
    >[0]['credentials'],
    verification: { verify, recoverVerification, cleanupVerification: async () => {} },
  };
  let version = 1;
  const advance = async () => {
    version++;
    await writeFile(join(source, 'code.ts'), `export const version = ${version};`);
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', `Upstream ${version}`);
    await git(source, 'push', upstream, 'develop');
    return git(source, 'rev-parse', 'HEAD');
  };
  return {
    service: () => createBackendProjectBaselineSync(deps),
    id: row.id,
    verify,
    recoverVerification,
    advance,
    before,
    repo,
    source,
    dir,
    git,
    credentials,
    release,
    track,
    goOffline: () => writeFile(offline, 'offline'),
  };
}

it('uses the effective upstream through a retained Host attachment and preserves existing task commits', async () => {
  const t = await setup();
  const target = await t.advance();
  const service = t.service();
  const prepared = await service.prepareDelegation(t.id);
  expect(prepared).toMatchObject({
    oid: target,
    offline: false,
    target: { remote: 'origin', baselineRef: 'refs/heads/develop' },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(target);
  expect(await t.git(t.repo, 'rev-parse', 'feature/task')).toBe(t.before);
  expect(t.verify).not.toHaveBeenCalled();
  expect(t.track).toHaveBeenCalledOnce();
  expect(t.credentials).toHaveBeenCalledWith({ projectId: t.id, host: LOCAL_HOST_REF });
  expect(t.release).toHaveBeenCalledTimes(t.credentials.mock.calls.length);
  expect((await t.service().get(t.id)).status).toBe('ready');
});

it('keeps failed checks blocked across database/service recovery and a real transport outage', async () => {
  const t = await setup();
  await t.advance();
  await t.service().configure(t.id, 0, { verification: { command: 'verify-fixture' } });
  t.verify.mockResolvedValue({
    status: 'failed',
    exitCode: 1,
    output: 'Actual verification failed',
  });
  expect((await t.service().synchronize(t.id, 'manual')).canDelegate).toBe(false);
  await t.goOffline();
  const restored = t.service();
  await expect(restored.prepareDelegation(t.id)).rejects.toThrow('cannot bypass');
  expect((await restored.get(t.id)).denied?.reason).toBe('verification-failed');
  expect(t.verify).toHaveBeenCalledOnce();
  expect(t.release).toHaveBeenCalledTimes(t.credentials.mock.calls.length);
  expect(await t.git(t.repo, 'rev-parse', 'feature/task')).toBe(t.before);
});

it('returns a frozen commit even when the baseline advances again, and retains verified offline use', async () => {
  const t = await setup();
  await t.service().configure(t.id, 0, { verification: { command: 'verify-fixture' } });
  const first = await t.advance();
  const frozen = await t.service().prepareDelegation(t.id);
  expect(frozen.oid).toBe(first);
  const next = await t.advance();
  const checked = await t.service().synchronize(t.id, 'manual');
  expect(checked.proof?.oid).toBe(next);
  await t.git(
    t.repo,
    'worktree',
    'add',
    '--no-track',
    '-b',
    'delegated-frozen',
    join(t.dir, 'frozen'),
    frozen.oid
  );
  expect(await t.git(t.repo, 'rev-parse', 'delegated-frozen')).toBe(first);
  await t.goOffline();
  const offline = await t.service().prepareDelegation(t.id);
  expect(offline).toMatchObject({ oid: next, offline: true, checkedAt: checked.lastContactAt });
  expect(t.verify).toHaveBeenCalledTimes(2);
  expect(t.release).toHaveBeenCalledTimes(t.credentials.mock.calls.length);
});
