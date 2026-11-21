import { writeFile } from 'node:fs/promises';
import type { Command } from '@emdash/core/primitives/exec/api';
import { gitContract, localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import { createLiveJobReplicaCache } from '@emdash/wire/live';
import { expect, vi } from 'vitest';
import type { Coordinator } from '@core/features/coordination/api/types';
import { CoordinatorDocuments } from '@core/features/coordination/node/coordinator-documents';
import {
  hostFileRefFromNativePath,
  hostPathFromNative,
} from '@core/primitives/desktop-runtime/api';

type Proxy = {
  exec(command: Command): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

/** Opt-in acceptance against the packaged Linux Host, never the desktop filesystem. */
export async function verifyRemoteCoordination(input: {
  runtime: HostRuntimesClient;
  proxy: Proxy;
  connectionId: string;
  version: string;
}) {
  const { runtime, proxy, connectionId } = input;
  const checks: string[] = [];
  const exec = async (command: string, args: string[], cwd?: string) => {
    const result = await proxy.exec({ command, args, cwd });
    expect(result.exitCode, `${command} failed in the isolated fixture`).toBe(0);
    return result.stdout.trim();
  };
  const root = await exec('mktemp', ['-d', '/home/devuser/emdash-coordination-XXXXXX']);
  if (!/^\/home\/devuser\/emdash-coordination-[A-Za-z0-9]+$/.test(root)) {
    throw new Error('The remote fixture returned an unexpected directory');
  }
  const repository = `${root}/repository`;
  const docsPath = `${root}/documents`;
  const workerPath = `${root}/worker`;
  const checkPath = `${root}/check`;
  const upstream = `${root}/upstream.git`;
  const seed = `${root}/upstream-seed`;
  const id = (suffix: string) => `${root.split('/').at(-1)}-${suffix}`;
  const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args]);
  const write = async (path: string, content: string) => {
    expect(await runtime.files.fs.createFile({ path: hostPathFromNative(path) })).toMatchObject({
      success: true,
    });
    expect(
      await runtime.files.fs.writeFile({
        path: hostPathFromNative(path),
        content,
        encoding: 'utf8',
        precondition: { kind: 'overwrite' },
      })
    ).toMatchObject({ success: true });
  };
  await exec('git', ['init', '-b', 'main', repository]);
  await git(repository, 'config', 'user.name', 'Remote acceptance');
  await git(repository, 'config', 'user.email', 'acceptance@example.invalid');
  await write(`${repository}/README.md`, 'Remote code baseline\n');
  await write(`${repository}/.gitignore`, 'cache/\n');
  await write(`${repository}/.emdash.json`, '{"preservePatterns":[]}\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'Isolated remote baseline');
  const baseline = await git(repository, 'rev-parse', 'HEAD');
  const registry = runtime.workspaceRegistry;
  expect(
    await registry.createWorkspace({ workspaceId: id('repository'), path: repository })
  ).toMatchObject({ success: true, data: { kind: 'repository', path: repository } });
  const management = {
    workspaceId: id('documents'),
    repositoryId: id('repository'),
    branch: 'emdash/manage/remote-acceptance',
    path: docsPath,
  };
  expect(await registry.createManagementWorktree(management)).toMatchObject({
    success: true,
    data: { creation: { purpose: 'management', baseRef: null } },
  });
  expect(await git(docsPath, 'ls-tree', '--name-only', 'HEAD')).toBe('');
  expect(
    await runtime.files.fs.exists({ path: hostPathFromNative(`${docsPath}/README.md`) })
  ).toMatchObject({ success: true, data: { exists: false } });
  checks.push('Packaged remote Host created independent management history without code files');

  const record: Coordinator = {
    version: '10',
    id: id('main'),
    kind: 'project',
    name: 'Remote acceptance',
    projectId: id('project'),
    projectIds: [id('project')],
    taskId: id('documents'),
    conversationId: id('conversation'),
    primary: {},
    delegationDefaults: {},
    tasks: {},
    events: [],
    purpose: '',
    lifecycle: { kind: 'finite', state: 'active' },
    workItems: {},
    checkpoints: [],
    createdAt: 0,
    updatedAt: 0,
    params: {
      id: id('documents'),
      projectId: id('project'),
      taskConfig: { version: '1', name: 'Remote main' },
      workspaceConfig: {
        version: '2',
        git: { kind: 'management', branchName: management.branch },
        workspace: { kind: 'new-worktree' },
      },
    },
  };
  const documents = new CoordinatorDocuments(async () => ({
    workspaceId: id('documents'),
    root: hostFileRefFromNativePath(docsPath, connectionId),
    runtime,
  }));
  const first = await documents.write(record, {
    path: 'plan.md',
    content: 'Frozen remote input\n',
  });
  await expect(
    documents.write(record, { path: 'plan.md', content: 'Missing disk version' })
  ).rejects.toThrow('disk version');
  const described = await documents.describe(record);
  const committed = await documents.commit(record, {
    paths: ['plan.md'],
    message: 'Save remote management plan',
    expectedRevision: described.revision,
  });
  await documents.write(record, {
    path: 'plan.md',
    content: 'New remote draft\n',
    expectedRevision: first.revision,
  });
  expect((await documents.read(record, 'plan.md', committed.hash)).content).toBe(
    'Frozen remote input\n'
  );
  expect((await documents.read(record, 'plan.md')).content).toBe('New remote draft\n');
  checks.push('Document service used remote files and Git, preserved frozen content after editing');

  expect(
    await registry.createWorktree({
      workspaceId: id('worker'),
      repositoryId: id('repository'),
      branch: 'feature/remote-worker',
      baseRef: baseline,
      path: workerPath,
      preservePatterns: [],
    })
  ).toMatchObject({ success: true });
  const started = await runtime.scripts.start({
    workspacePath: workerPath,
    script: 'prepare',
    provenance: 'manual',
    facts: { workspaceId: id('worker'), repositoryPath: repository },
    command: 'pwd; test -f README.md && printf remote-coordination-worker',
    shellSetup: '',
  });
  expect(started.success).toBe(true);
  if (!started.success) throw new Error('Could not start the isolated remote script');
  expect(
    await runtime.scripts.wait({
      workspacePath: workerPath,
      script: 'prepare',
      runId: started.data.runId,
    })
  ).toMatchObject({
    success: true,
    data: {
      status: 'succeeded',
      exitCode: 0,
      outputTail: expect.stringContaining('remote-coordination-worker'),
    },
  });
  checks.push('Remote PTY script executed in its pinned code worktree through the Host runtime');

  await exec('git', ['init', '--bare', upstream]);
  await git(repository, 'remote', 'add', 'origin', upstream);
  await git(repository, 'push', 'origin', 'main');
  await exec('git', ['clone', '-b', 'main', upstream, seed]);
  await git(seed, 'config', 'user.name', 'Remote acceptance');
  await git(seed, 'config', 'user.email', 'acceptance@example.invalid');
  await write(`${seed}/new-code.txt`, 'New remote upstream content\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'Advance remote upstream');
  await git(seed, 'push', 'origin', 'main');
  const target = await git(seed, 'rev-parse', 'HEAD');
  const jobs = createLiveJobReplicaCache(
    gitContract.checkout.syncBaseline,
    runtime.git.checkout.syncBaseline
  );
  try {
    const lease = await jobs.start({
      checkout: hostPathFromNative(repository),
      remote: 'origin',
      upstreamRef: localBranchRefSchema.parse('refs/heads/main'),
      baselineRef: localBranchRefSchema.parse('refs/heads/main'),
    });
    const handle = await lease.ready();
    expect(await handle.result).toMatchObject({
      kind: 'updated',
      beforeOid: baseline,
      afterOid: target,
    });
    await lease.release();
  } finally {
    await jobs.dispose();
  }
  expect(await git(workerPath, 'rev-parse', 'HEAD')).toBe(baseline);
  expect(await git(docsPath, 'rev-parse', 'HEAD')).toBe(committed.hash);
  checks.push(
    'Remote baseline safely fast-forwarded while worker and management branches stayed pinned'
  );

  const removal = {
    workspaceId: id('check'),
    repositoryId: id('repository'),
    repositoryPath: repository,
    path: checkPath,
    branch: 'emdash/verify/remote-acceptance',
    oid: target,
  };
  expect(
    await registry.createWorktree({
      workspaceId: removal.workspaceId,
      repositoryId: removal.repositoryId,
      path: checkPath,
      branch: removal.branch,
      baseRef: target,
      preservePatterns: [],
    })
  ).toMatchObject({ success: true });
  await vi.waitFor(async () => {
    const row = (await registry.records.state(undefined, 'list').snapshot()).data[id('check')];
    expect(
      row?.lifecycle?.steps.some((step) => ['pending', 'running'].includes(step.status))
    ).not.toBe(true);
  });
  await exec('mkdir', ['-p', `${checkPath}/cache`]);
  await write(`${checkPath}/cache/preserve.txt`, 'Preserve ignored remote data');
  expect(await registry.removeUnchangedWorktree(removal)).toMatchObject({ success: false });
  await exec('rm', ['-rf', '--', `${checkPath}/cache`]);
  expect(await registry.removeUnchangedWorktree(removal)).toMatchObject({ success: true });
  expect(await git(repository, 'rev-parse', removal.branch)).toBe(target);
  checks.push(
    'Remote safe cleanup refused ignored data and retained the verification branch after removal'
  );

  return {
    async afterReconnect() {
      const rows = (await registry.records.state(undefined, 'list').snapshot()).data;
      expect(rows[id('documents')]).toMatchObject({
        path: docsPath,
        creation: { purpose: 'management' },
      });
      expect(rows[id('worker')]).toMatchObject({
        path: workerPath,
        creation: { baseRef: baseline },
      });
      expect(rows[id('check')]).toBeUndefined();
      expect((await documents.read(record, 'plan.md')).content).toBe('New remote draft\n');
      expect((await documents.read(record, 'plan.md', committed.hash)).content).toBe(
        'Frozen remote input\n'
      );
      checks.push(
        'Actual SSH disconnect and reconnect preserved remote records and document contents'
      );
      const evidence = process.env['EMDASH_TEST_REMOTE_COORDINATION_EVIDENCE'];
      if (evidence)
        await writeFile(
          evidence,
          JSON.stringify(
            {
              passed: true,
              version: input.version,
              platform: 'linux-arm64',
              checks,
              baseline,
              target,
              documentCommit: committed.hash,
            },
            null,
            2
          )
        );
    },
    async cleanup() {
      for (const workspaceId of [id('worker'), id('documents'), id('repository')]) {
        expect(await registry.deleteWorkspace({ workspaceId })).toMatchObject({ success: true });
      }
      await exec('rm', ['-rf', '--', root]);
    },
  };
}
