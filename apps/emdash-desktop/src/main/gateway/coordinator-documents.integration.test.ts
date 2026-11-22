import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { hostFileRef } from '@emdash/core/primitives/path/api';
import { filesContract } from '@emdash/core/runtimes/files/api';
import { createFilesController, FilesRuntime } from '@emdash/core/runtimes/files/node';
import { gitContract } from '@emdash/core/runtimes/git/api';
import { createGitController, GitRuntime } from '@emdash/core/runtimes/git/node';
import type { IWatchService } from '@emdash/core/services/fs-watch/api';
import { ok } from '@emdash/shared';
import { createLiveJobReplicaCache } from '@emdash/wire/live';
import { client, connect, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Coordinator } from '@core/features/coordination/api/types';
import { CoordinatorDocuments } from '@core/features/coordination/node/coordinator-documents';
import { sourceControlContract } from '@core/features/source-control/api/contract';
import { createSourceControlWireController } from '@core/features/source-control/node/wire-controller';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const watcher: IWatchService = {
  watch: () => ({ ready: async () => ok(undefined), release: async () => {} }),
  dispose: async () => {},
};
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'emdash-documents-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Document test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(join(repo, 'README.md'), 'code history');
  await git('add', '.');
  await git('commit', '-m', 'code');
  const code = await git('rev-parse', 'HEAD');
  await git('switch', '--orphan', 'emdash/manage/main');
  await writeFile(join(repo, 'plan.md'), 'first plan');
  await git('add', '.');
  await git('commit', '-m', 'first plan');
  const first = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'plan.md'), 'second plan');
  await git('add', '.');
  await git('commit', '-m', 'second plan');
  const files = new FilesRuntime({ watcher });
  const gitRuntime = new GitRuntime({ watcher });
  const fp = memoryTransportPair();
  const gp = memoryTransportPair();
  const fc = createFilesController(files);
  const gc = createGitController(gitRuntime);
  const stopFiles = serve(fp.right, fc);
  const stopGit = serve(gp.right, gc);
  cleanups.push(async () => {
    stopFiles();
    stopGit();
    await fc.dispose?.();
    await gc.dispose?.();
    await files.dispose();
    await gitRuntime.dispose();
  });
  const runtime = {
    files: client(filesContract, connect(fp.left)),
    git: client(gitContract, connect(gp.left)),
  };
  const record: Coordinator = {
    version: '12',
    id: 'project:project',
    kind: 'project',
    name: 'Main agent',
    projectId: 'project',
    projectIds: ['project'],
    taskId: 'main',
    conversationId: 'conversation',
    primary: {},
    delegationDefaults: {},
    tasks: {},
    events: [],
    purpose: '',
    lifecycle: { kind: 'ongoing', state: 'active' },
    workItems: {},
    checkpoints: [],
    optimizationRuns: {},
    optimizationSuggestions: {},
    livePromotions: {},
    createdAt: 0,
    updatedAt: 0,
    params: {
      id: 'main',
      projectId: 'project',
      taskConfig: { version: '1', name: 'Main agent', role: 'coordination' },
      workspaceConfig: {
        version: '2',
        workspace: { kind: 'new-worktree' },
        git: { kind: 'management', branchName: 'emdash/manage/main' },
      },
    },
  };
  const service = new CoordinatorDocuments(async () => ({
    workspaceId: 'workspace',
    root: hostFileRef(LOCAL_HOST_REF, hostPathFromNative(repo)),
    runtime,
  }));
  return { service, record, dir, repo, git, code, first, runtime };
}

describe('management documents over host Wire runtimes', () => {
  it('copies selected legacy text into an independent worktree without overwriting either side', async () => {
    const { record, repo, dir, git, runtime } = await setup();
    await git('switch', 'main');
    await git('switch', '-c', 'legacy-main');
    await mkdir(join(repo, 'plans'));
    await writeFile(join(repo, 'plans', 'decision.md'), 'selected legacy decision');
    const originalHead = await git('rev-parse', 'HEAD');
    if (!record.params) throw new Error('Missing main params');
    record.params.workspaceConfig.git = {
      kind: 'create-branch',
      branchName: 'legacy-main',
      fromBranch: { type: 'local', branch: 'main' },
    };
    const source = {
      projectId: record.projectId,
      taskId: record.taskId,
      params: structuredClone(record.params),
      state: 'ready' as const,
    };
    const targetPath = join(dir, 'migration-target');
    await git('worktree', 'add', '--detach', targetPath, 'HEAD');
    await exec('git', ['switch', '--orphan', 'emdash/manage/target'], { cwd: targetPath });
    await exec('git', ['commit', '--allow-empty', '-m', 'management root'], { cwd: targetPath });
    const target = {
      ...source,
      taskId: 'target',
      params: {
        ...structuredClone(source.params),
        id: 'target',
        workspaceConfig: {
          version: '2' as const,
          git: { kind: 'management' as const, branchName: 'emdash/manage/target' },
          workspace: { kind: 'new-worktree' as const },
        },
      },
    };
    const documents = new CoordinatorDocuments(async (bound) => ({
      workspaceId:
        bound.documentStorage?.taskId === 'target' ? 'target-workspace' : 'source-workspace',
      root: hostFileRef(
        LOCAL_HOST_REF,
        hostPathFromNative(bound.documentStorage?.taskId === 'target' ? targetPath : repo)
      ),
      runtime,
    }));
    await expect(documents.read(record, 'plans/decision.md')).rejects.toThrow('migration');
    const frozen = await documents.readMigrationSource(record, source, 'plans/decision.md');
    const copied = await documents.copyMigrationDocument(record, target, frozen);
    expect(copied.content).toBe('selected legacy decision');
    expect(await documents.copyMigrationDocument(record, target, frozen)).toEqual(copied);
    expect(await readFile(join(repo, 'plans', 'decision.md'), 'utf8')).toBe(
      'selected legacy decision'
    );
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('code history');
    await expect(readFile(join(targetPath, 'README.md'))).rejects.toThrow();
    expect(await git('rev-parse', 'HEAD')).toBe(originalHead);
    expect(record.params.workspaceConfig.git.kind).toBe('create-branch');
    await writeFile(join(targetPath, 'plans', 'decision.md'), 'destination edit');
    await expect(documents.copyMigrationDocument(record, target, frozen)).rejects.toThrow(
      'destination changed'
    );
    expect(await readFile(join(targetPath, 'plans', 'decision.md'), 'utf8')).toBe(
      'destination edit'
    );
    const outside = join(dir, 'outside-folder');
    await mkdir(outside);
    await symlink(outside, join(targetPath, 'linked'));
    await expect(
      documents.copyMigrationDocument(record, target, { ...frozen, path: 'linked/decision.md' })
    ).rejects.toThrow('symbolic links');
  });

  it('writes new documents and requires a current disk version before updating', async () => {
    const { service, record, repo } = await setup();
    const created = await service.write(record, { path: 'draft.md', content: 'first draft' });
    expect(created.content).toBe('first draft');
    await expect(
      service.write(record, { path: 'draft.md', content: 'unversioned overwrite' })
    ).rejects.toThrow('provide its disk version');
    const updated = await service.write(record, {
      path: 'draft.md',
      content: 'second draft',
      expectedRevision: created.revision,
    });
    expect(updated.revision).not.toBe(created.revision);
    await writeFile(join(repo, 'draft.md'), 'concurrent edit');
    await expect(
      service.write(record, {
        path: 'draft.md',
        content: 'stale overwrite',
        expectedRevision: updated.revision,
      })
    ).rejects.toThrow('changed');
    expect(await readFile(join(repo, 'draft.md'), 'utf8')).toBe('concurrent edit');
    await expect(
      service.write(record, {
        path: 'draft.md',
        content: 'binary\0',
        expectedRevision: updated.revision,
      })
    ).rejects.toThrow('text document');
  });

  it('uses independent storage while preserving the directory main config and rejecting links', async () => {
    const { service, record, repo, dir } = await setup();
    if (!record.params) throw new Error('Missing main params');
    const params = structuredClone(record.params);
    record.params.workspaceConfig = {
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'directory' },
    };
    record.documentStorage = {
      projectId: 'storage-project',
      taskId: 'storage-task',
      state: 'ready',
      params,
    };
    const directoryConfig = structuredClone(record.params);
    expect((await service.read(record, 'plan.md')).content).toBe('second plan');
    const saved = await service.write(record, {
      path: 'linked-plan.md',
      content: 'stored outside the conversation directory',
    });
    expect(saved.workspaceId).toBe('workspace');
    expect(record.params).toEqual(directoryConfig);
    await writeFile(join(dir, 'outside.md'), 'keep');
    await symlink(join(dir, 'outside.md'), join(repo, 'escape.md'));
    await expect(
      service.write(record, {
        path: 'escape.md',
        content: 'overwrite',
        expectedRevision: 'disk:etag',
      })
    ).rejects.toThrow('links');
    expect(await readFile(join(dir, 'outside.md'), 'utf8')).toBe('keep');
  });

  it('creates without overwriting and returns content versions that reject stale reads', async () => {
    const { service, record, repo } = await setup();
    await service.create(record, 'decision.md');
    await expect(service.create(record, 'decision.md')).rejects.toThrow('already-exists');
    await writeFile(join(repo, 'decision.md'), 'saved decision');
    const doc = await service.read(record, 'decision.md');
    expect(doc).toMatchObject({
      coordinatorId: record.id,
      path: 'decision.md',
      content: 'saved decision',
      workspaceId: 'workspace',
    });
    expect(doc.revision).toMatch(/^disk:/);
    await expect(service.read(record, 'decision.md', doc.revision)).resolves.toEqual(doc);
    await writeFile(join(repo, 'decision.md'), 'changed decision');
    await expect(service.read(record, 'decision.md', doc.revision)).rejects.toThrow('changed');
    await expect(readFile(join(repo, 'plan.md'), 'utf8')).resolves.toBe('second plan');
  });
  it('reads committed history and refuses another branch independent history', async () => {
    const { service, record, first, code } = await setup();
    await expect(service.read(record, 'plan.md', first)).resolves.toMatchObject({
      content: 'first plan',
      revision: first,
    });
    await expect(service.read(record, 'README.md', code)).rejects.toThrow(
      'outside this management branch history'
    );
    await expect(service.read(record, 'missing.md', first)).rejects.toThrow('unavailable');
  });
  it.each([
    '../outside.md',
    '/outside.md',
    '.git/config',
    'notes/../plan.md',
    'notes//plan.md',
    'C:/plan.md',
    'notes\\plan.md',
  ])('rejects a non-document path %s', async (path) => {
    const { service, record } = await setup();
    await expect(service.create(record, path)).rejects.toThrow();
    await expect(service.read(record, path)).rejects.toThrow();
  });
  it('refuses symlink escape and missing parents without changing outside files', async () => {
    const { service, record, dir, repo } = await setup();
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), 'outside');
    await symlink(outside, join(repo, 'linked'), 'dir');
    await symlink(join(repo, 'plan.md'), join(repo, 'alias.md'));
    await expect(service.read(record, 'linked/secret.md')).rejects.toThrow('inside');
    await expect(service.create(record, 'linked/created.md')).rejects.toThrow('inside');
    await expect(service.read(record, 'alias.md')).rejects.toThrow('symbolic links');
    await expect(service.create(record, 'missing/created.md')).rejects.toThrow('parent folder');
    await expect(readFile(join(outside, 'secret.md'), 'utf8')).resolves.toBe('outside');
  });
  it('rejects binary and truncated text instead of passing incomplete context', async () => {
    const { service, record, repo } = await setup();
    await writeFile(join(repo, 'binary.md'), 'a\0b');
    await writeFile(join(repo, 'large.md'), 'x'.repeat(512 * 1024 + 1));
    await expect(service.read(record, 'binary.md')).rejects.toThrow('text document');
    await expect(service.read(record, 'large.md')).rejects.toThrow('512 KiB');
  });
  it('preserves a legacy code workspace and rejects a changed management checkout', async () => {
    const { service, record, git } = await setup();
    const legacy = structuredClone(record);
    legacy.params!.workspaceConfig.git = {
      kind: 'create-branch',
      branchName: 'code',
      fromBranch: { type: 'local', branch: 'main' },
    };
    await expect(service.describe(legacy)).rejects.toThrow('migration');
    await git('switch', 'main');
    await expect(service.describe(record)).rejects.toThrow('Return the document workspace');
  });
});

it('commits selected management documents over Wire without including other staged files or the code baseline', async () => {
  const { service, record, repo, git, code } = await setup();
  const before = await service.describe(record);
  await writeFile(join(repo, 'unrelated.md'), 'keep staged');
  await git('add', 'unrelated.md');
  await writeFile(join(repo, 'decision.md'), 'selected document');
  const committed = await service.commit(record, {
    paths: ['decision.md'],
    message: 'Save decision',
    expectedRevision: before.revision,
  });
  expect(committed.hash).toBe(await git('rev-parse', 'HEAD'));
  expect(await git('show', 'HEAD:decision.md')).toBe('selected document');
  expect(await git('diff', '--cached', '--name-only')).toBe('unrelated.md');
  expect(await git('rev-parse', 'main')).toBe(code);
  await expect(service.read(record, 'decision.md', committed.hash)).resolves.toMatchObject({
    content: 'selected document',
  });
  await expect(
    service.commit(record, {
      paths: ['decision.md'],
      message: 'Stale retry',
      expectedRevision: before.revision,
    })
  ).rejects.toThrow('changed');
  await unlink(join(repo, 'decision.md'));
  const removed = await service.commit(record, {
    paths: ['decision.md'],
    message: 'Remove decision',
    expectedRevision: committed.hash,
  });
  expect(removed.hash).not.toBe(committed.hash);
  expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('decision.md');
  expect(await git('diff', '--cached', '--name-only')).toBe('unrelated.md');
});
it('refuses unsafe document selections before making a commit', async () => {
  const { service, record, repo, dir, git } = await setup();
  const before = await service.describe(record);
  await writeFile(join(dir, 'outside.md'), 'outside');
  await symlink(join(dir, 'outside.md'), join(repo, 'linked.md'));
  await expect(
    service.commit(record, {
      paths: ['linked.md'],
      message: 'Unsafe',
      expectedRevision: before.revision,
    })
  ).rejects.toThrow('inside');
  await expect(
    service.commit(record, {
      paths: ['.git/config'],
      message: 'Unsafe',
      expectedRevision: before.revision,
    })
  ).rejects.toThrow();
  expect(await git('rev-parse', 'HEAD')).toBe(before.revision);
  expect(await git('diff', '--cached', '--name-only')).toBe('');
});

it('publishes a configured management branch through the desktop job and releases its credential lease', async () => {
  const { service, record, dir, repo, git, code, runtime } = await setup();
  const fork = join(dir, 'personal fork.git');
  await git('init', '--bare', fork);
  await git('remote', 'add', 'personal', fork);
  const workspace = await service.describe(record);
  await expect(service.preparePush(record, workspace.revision)).rejects.toThrow(
    'Configure a personal fork'
  );
  record.documentPushTarget = await service.pushTarget(record, 'personal');
  expect((await service.pushTargets(record)).targets).toEqual([record.documentPushTarget]);
  const plan = await service.preparePush(record, workspace.revision);
  const release = vi.fn();
  const mintOperationCredentials = vi.fn(async () => ({
    credentials: { port: 9, nonce: 'isolated-operation', host: 'example.invalid' },
    release,
  }));
  const identity = {
    workspaceId: workspace.workspaceId,
    projectId: record.projectId,
    host: LOCAL_HOST_REF,
    path: repo,
  };
  const controller = createSourceControlWireController({
    runtimes: { client: async () => ok(runtime as never) },
    workspaceIdentity: { resolve: async () => identity, resolveProject: async () => identity },
    projects: {
      requireAttached: () => {
        throw new Error('Checkout push must use its workspace identity');
      },
    },
    mintOperationCredentials,
  });
  const pair = memoryTransportPair();
  const stop = serve(pair.right, controller);
  const desktop = client(sourceControlContract, connect(pair.left));
  const jobs = createLiveJobReplicaCache(
    sourceControlContract.checkout.pushBranch,
    desktop.checkout.pushBranch
  );
  const lease = await jobs.start(plan);
  try {
    const running = await lease.ready();
    await expect(running.result).resolves.toMatchObject({
      oid: workspace.revision,
      targetRef: `refs/heads/${workspace.branch}`,
    });
    expect(mintOperationCredentials).toHaveBeenCalledWith({
      projectId: record.projectId,
      host: LOCAL_HOST_REF,
    });
    expect(release).toHaveBeenCalledOnce();
    expect(
      (await exec('git', ['--git-dir', fork, 'for-each-ref', '--format=%(refname)'])).stdout.trim()
    ).toBe(`refs/heads/${workspace.branch}`);
    expect(await git('rev-parse', 'main')).toBe(code);
  } finally {
    await lease.release();
    await jobs.dispose();
    stop();
    await controller.dispose?.();
  }
  await git('remote', 'set-url', 'personal', join(dir, 'retargeted.git'));
  await expect(service.preparePush(record, workspace.revision)).rejects.toThrow(
    'destination changed'
  );
});
