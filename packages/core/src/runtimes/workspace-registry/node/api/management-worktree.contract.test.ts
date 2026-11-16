import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '@emdash/shared/testing';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalAttachmentStore } from '#services/attachments/node/local-attachment-store';
import { workspaceRegistryContract } from '../../api/contract';
import { workspaceRegistryStore } from '../persistence/store';
import { WorkspaceRegistryRuntime } from '../runtime';
import { createWorkspaceRegistryController } from './controller';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
let root: string;
let handle: Awaited<ReturnType<typeof workspaceRegistryStore.openTemp>>;
let runtime: WorkspaceRegistryRuntime;
let wire: ReturnType<typeof createTestWire<typeof workspaceRegistryContract>>;
const run = vi.fn(async () => ({ status: 'succeeded' as const, outputTail: '' }));
function start() {
  runtime = new WorkspaceRegistryRuntime({
    handle,
    clock: new ManualClock(10000),
    attachments: new LocalAttachmentStore(path.join(root, 'attachments')),
    activation: { runner: { run } },
  });
  wire = createTestWire(workspaceRegistryContract, createWorkspaceRegistryController(runtime));
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-management-contract-')));
  handle = await workspaceRegistryStore.openTemp();
  run.mockClear();
  start();
});
afterEach(async () => {
  wire.dispose();
  runtime.dispose();
  handle.close();
  await fs.rm(root, { recursive: true, force: true });
});

it('creates and restores independent document history without project scripts, artifacts or publication', async () => {
  const repo = path.join(root, 'repository');
  await fs.mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await fs.writeFile(path.join(repo, 'README.md'), 'Code baseline\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'cache/\n');
  await fs.mkdir(path.join(repo, 'cache'));
  await fs.writeFile(path.join(repo, 'cache', 'dependency'), 'Code dependency');
  await fs.writeFile(
    path.join(repo, '.emdash.json'),
    JSON.stringify({
      preservePatterns: ['cache/**'],
      scripts: {
        prepare: 'code prepare',
        setup: 'code setup',
        run: 'code run',
        teardown: 'code teardown',
      },
    })
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Code baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  expect(
    (await wire.client.createWorkspace({ workspaceId: 'repository', path: repo })).success
  ).toBe(true);
  await wire.client.patchPersonalProjectConfig({
    workspaceId: 'repository',
    patch: {
      scripts: {
        prepare: 'personal prepare',
        setup: 'personal setup',
        run: 'personal run',
        teardown: 'personal teardown',
      },
      autoRunSetup: true,
      autoRunRun: true,
    },
  });
  const spec = {
    workspaceId: 'documents',
    repositoryId: 'repository',
    branch: 'emdash/manage/test',
    path: path.join(root, 'documents'),
  };
  const created = await wire.client.createManagementWorktree(spec);
  expect(created).toMatchObject({
    success: true,
    data: {
      creation: { purpose: 'management', baseRef: null },
      lastCreateOutcome: { status: 'succeeded' },
    },
  });
  expect(git(spec.path, 'ls-tree', '--name-only', 'HEAD')).toBe('');
  expect(() => git(repo, 'merge-base', 'main', spec.branch)).toThrow();
  await expect(fs.stat(path.join(spec.path, 'cache'))).rejects.toThrow();
  await expect(fs.stat(path.join(spec.path, '.emdash.json'))).rejects.toThrow();
  expect(await wire.client.getProjectConfig({ workspaceId: spec.workspaceId })).toMatchObject({
    success: true,
    data: { resolved: { prepare: { value: 'personal prepare' } } },
  });
  const activated = await wire.client.activateWorkspace({ workspaceId: spec.workspaceId });
  expect(activated).toMatchObject({
    success: true,
    data: {
      runtime: {
        activation: { scripts: { prepare: 'skipped', setup: 'skipped', run: 'skipped' } },
      },
    },
  });
  expect(
    await wire.client.runScript({
      workspaceId: spec.workspaceId,
      script: 'setup',
      provenance: 'manual',
    })
  ).toMatchObject({ success: false, error: { type: 'script-not-configured' } });
  await wire.client.deactivateWorkspace({ workspaceId: spec.workspaceId });
  expect(run).not.toHaveBeenCalled();
  await fs.writeFile(path.join(spec.path, 'plan.md'), 'Preserved document\n');
  wire.dispose();
  runtime.dispose();
  start();
  expect(await wire.client.createManagementWorktree(spec)).toMatchObject({
    success: true,
    data: { creation: { purpose: 'management' } },
  });
  await wire.client.activateWorkspace({ workspaceId: spec.workspaceId });
  expect(run).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(spec.path, 'plan.md'), 'utf8')).toBe('Preserved document\n');
  expect(git(repo, 'rev-parse', 'main')).toBe(baseline);
  expect(
    await wire.client.createWorktree({ ...spec, baseRef: 'main', preservePatterns: [] })
  ).toMatchObject({ success: false, error: { type: 'immutable-field-mismatch' } });
  const code = await wire.client.createWorktree({
    workspaceId: 'code-task',
    repositoryId: 'repository',
    branch: 'feature/code',
    baseRef: 'main',
    path: path.join(root, 'code-task'),
    preservePatterns: [],
  });
  expect(code.success).toBe(true);
  await wire.client.activateWorkspace({ workspaceId: 'code-task' });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(await fs.readFile(path.join(root, 'code-task', 'cache', 'dependency'), 'utf8')).toBe(
    'Code dependency'
  );
});
