import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deferred, waitFor } from '@emdash/shared/testing';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, expect, it, vi } from 'vitest';
// oxlint-disable-next-line emdash/core-module-boundaries -- real scripts/registry Host composition
import { scriptsContract } from '#runtimes/scripts/api';
// oxlint-disable-next-line emdash/core-module-boundaries -- see above
import { createScriptsController } from '#runtimes/scripts/node/api/controller';
// oxlint-disable-next-line emdash/core-module-boundaries -- see above
import { ScriptsRuntime } from '#runtimes/scripts/node/runtime';
// oxlint-disable-next-line emdash/core-module-boundaries -- see above
import { ChildProcessPtySpawner } from '#runtimes/scripts/node/script-test-support';
import { LocalAttachmentStore } from '#services/attachments/node/local-attachment-store';
import { workspaceRegistryContract } from '../../api/contract';
import { workspaceRegistryStore } from '../persistence/store';
import { WorkspaceRegistryRuntime } from '../runtime';
import { createWorkspaceRegistryController } from './controller';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ws-clean-check-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Check',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Check',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
  git(repo, 'init', '-b', 'main');
  await writeFile(path.join(repo, 'file.txt'), 'baseline');
  await writeFile(path.join(repo, '.gitignore'), 'cache/\n');
  await writeFile(
    path.join(repo, '.emdash.json'),
    JSON.stringify({ scripts: { teardown: 'printf teardown > ../teardown-ran' } })
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Baseline');
  const oid = git(repo, 'rev-parse', 'HEAD');
  const handle = await workspaceRegistryStore.openTemp();
  cleanups.push(async () => handle.close());
  const scripts = new ScriptsRuntime({
    spawner: new ChildProcessPtySpawner(),
    userEnv: async () =>
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
  });
  cleanups.push(async () => scripts.dispose());
  const scriptsWire = createTestWire(scriptsContract, createScriptsController(scripts));
  cleanups.push(async () => scriptsWire.dispose());
  let sessions = 0;
  let probe = async () => sessions;
  const kill = vi.fn(async () => {});
  const runtime = new WorkspaceRegistryRuntime({
    handle,
    attachments: new LocalAttachmentStore(path.join(root, 'attachments')),
    scripts: scriptsWire.client,
    countSessions: () => probe(),
    killSessions: kill,
  });
  cleanups.push(async () => runtime.dispose());
  const wire = createTestWire(
    workspaceRegistryContract,
    createWorkspaceRegistryController(runtime)
  );
  cleanups.push(async () => wire.dispose());
  expect((await wire.client.createWorkspace({ workspaceId: 'repo', path: repo })).success).toBe(
    true
  );
  const input = {
    workspaceId: 'check',
    repositoryId: 'repo',
    repositoryPath: repo,
    path: path.join(root, 'check'),
    branch: 'emdash/verify/check',
    oid,
  };
  expect(
    (
      await wire.client.createWorktree({
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        path: input.path,
        branch: input.branch,
        baseRef: oid,
        preservePatterns: [],
      })
    ).success
  ).toBe(true);
  await waitFor(async () => {
    const record = (await wire.client.records.state(undefined, 'list').snapshot()).data.check;
    return (
      !!record &&
      !record.lifecycle?.steps.some(
        (step) => step.status === 'pending' || step.status === 'running'
      )
    );
  });
  return {
    root,
    repo,
    git,
    input,
    wire,
    scriptsWire,
    kill,
    active: (count: number) => {
      sessions = count;
    },
    sessionProbe: (read: () => Promise<number>) => {
      probe = read;
    },
    remove: () => wire.client.removeUnchangedWorktree(input),
  };
}

it('removes only the unchanged checkout, retains its branch, and never runs teardown or session kills', async () => {
  const t = await setup();
  expect(await t.remove()).toEqual({ success: true, data: undefined });
  await expect(lstat(t.input.path)).rejects.toThrow();
  await expect(lstat(path.join(t.root, 'teardown-ran'))).rejects.toThrow();
  expect(t.kill).not.toHaveBeenCalled();
  expect(t.git(t.repo, 'rev-parse', t.input.branch)).toBe(t.input.oid);
  expect(
    (await t.wire.client.records.state(undefined, 'list').snapshot()).data.check
  ).toBeUndefined();
  expect(await t.remove()).toEqual({ success: true, data: undefined });
  await mkdir(t.input.path);
  await writeFile(path.join(t.input.path, 'user.txt'), 'preserve');
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'identity-changed' } });
  expect(await readFile(path.join(t.input.path, 'user.txt'), 'utf8')).toBe('preserve');
});

it.each(['tracked', 'untracked', 'ignored', 'assume-unchanged', 'skip-worktree'])(
  'preserves %s files even when Git could remove them without force',
  async (kind) => {
    const t = await setup();
    if (kind === 'ignored') {
      await mkdir(path.join(t.input.path, 'cache'));
      await writeFile(path.join(t.input.path, 'cache/output'), 'preserve');
    } else if (kind === 'untracked') {
      await writeFile(path.join(t.input.path, 'user.txt'), 'preserve');
    } else {
      if (kind === 'assume-unchanged' || kind === 'skip-worktree')
        t.git(t.input.path, 'update-index', `--${kind}`, 'file.txt');
      await writeFile(path.join(t.input.path, 'file.txt'), 'preserve');
    }
    expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'worktree-dirty' } });
    expect((await lstat(t.input.path)).isDirectory()).toBe(true);
    expect(t.git(t.repo, 'rev-parse', 'HEAD')).toBe(t.input.oid);
  }
);

it('refuses live sessions, running scripts, and Git operation locks without stopping them', async () => {
  const t = await setup();
  t.active(1);
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'workspace-active' } });
  t.active(0);
  const started = await t.scriptsWire.client.start({
    workspacePath: t.input.path,
    script: 'prepare',
    provenance: 'manual',
    command: 'exec sleep 30',
    shellSetup: '',
    facts: { workspaceId: 'check' },
  });
  expect(started.success).toBe(true);
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'workspace-active' } });
  await t.scriptsWire.client.stop({ workspacePath: t.input.path, script: 'prepare' });
  if (!started.success) throw new Error('Script did not start');
  await t.scriptsWire.client.wait({
    workspacePath: t.input.path,
    script: 'prepare',
    runId: started.data.runId,
  });
  const admin = t.git(t.input.path, 'rev-parse', '--absolute-git-dir');
  await writeFile(path.join(admin, 'MERGE_HEAD'), t.input.oid);
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'workspace-active' } });
  expect(t.kill).not.toHaveBeenCalled();
});

it('refuses changed branch/commit, parent and path identity', async () => {
  const t = await setup();
  expect(
    await t.wire.client.removeUnchangedWorktree({ ...t.input, repositoryPath: t.root })
  ).toMatchObject({ success: false, error: { reason: 'identity-changed' } });
  t.git(t.input.path, 'commit', '--allow-empty', '-m', 'User commit');
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'identity-changed' } });
  expect(t.git(t.input.path, 'log', '-1', '--format=%s')).toBe('User commit');
});

it('refuses a replaced symlink and never deletes its destination', async () => {
  const t = await setup();
  const moved = path.join(t.root, 'moved');
  t.git(t.repo, 'worktree', 'move', t.input.path, moved);
  await symlink(moved, t.input.path, 'dir');
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'unsafe-path' } });
  expect(await readFile(path.join(moved, 'file.txt'), 'utf8')).toBe('baseline');
});

it('recovers after Git removed the artifact but the registry completion was lost', async () => {
  const t = await setup();
  t.git(t.repo, 'worktree', 'remove', t.input.path);
  expect(await t.remove()).toEqual({ success: true, data: undefined });
  expect(
    (await t.wire.client.records.state(undefined, 'list').snapshot()).data.check
  ).toBeUndefined();
});

it('removes only matching Git registration when the checkout directory disappeared', async () => {
  const t = await setup();
  await rm(t.input.path, { recursive: true });
  expect(await t.remove()).toEqual({ success: true, data: undefined });
  expect(t.git(t.repo, 'worktree', 'list')).not.toContain(t.input.path);
  expect(t.git(t.repo, 'rev-parse', t.input.branch)).toBe(t.input.oid);
});

it('serializes manual script startup against cleanup instead of starting in a removed directory', async () => {
  const t = await setup();
  const entered = deferred<void>();
  const release = deferred<void>();
  t.sessionProbe(async () => {
    entered.resolve();
    await release.promise;
    return 0;
  });
  const cleaning = t.remove();
  await entered.promise;
  const starting = t.wire.client.runScript({
    workspaceId: 'check',
    script: 'teardown',
    provenance: 'manual',
  });
  release.resolve();
  expect((await cleaning).success).toBe(true);
  expect(await starting).toMatchObject({ success: false, error: { type: 'workspace-not-found' } });
  await expect(lstat(path.join(t.root, 'teardown-ran'))).rejects.toThrow();
});

it('preserves a checkout that was activated even after it has no sessions', async () => {
  const t = await setup();
  expect((await t.wire.client.activateWorkspace({ workspaceId: 'check' })).success).toBe(true);
  expect(await t.remove()).toMatchObject({ success: false, error: { reason: 'workspace-active' } });
  expect((await lstat(t.input.path)).isDirectory()).toBe(true);
});
