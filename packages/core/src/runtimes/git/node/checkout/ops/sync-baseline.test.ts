import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ok } from '@emdash/shared';
import { client, connect, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { afterEach, expect, it, vi } from 'vitest';
import { gitContract, localBranchRefSchema } from '#runtimes/git/api';
import type { SyncBaselineJobInput } from '#runtimes/git/api/checkout/baseline-sync';
import type { CheckoutIdentity } from '#runtimes/git/node/allocation/identity';
import { createGitController } from '#runtimes/git/node/api/controller';
import { GitRuntime } from '#runtimes/git/node/git-runtime';
import { hostPath } from '#runtimes/git/node/testing/paths';
import { createBoundExec, type BoundExec } from '#services/exec/api';
import { syncBaseline } from './sync-baseline';

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function identity(repo: string): CheckoutIdentity {
  const gitDir = path.join(repo, '.git');
  return {
    repositoryId: gitDir,
    objectStoreId: path.join(gitDir, 'objects'),
    checkoutId: JSON.stringify([repo, gitDir]),
    checkoutRoot: repo,
    gitDir,
    gitCommonDir: gitDir,
    objectStoreDir: path.join(gitDir, 'objects'),
  } as CheckoutIdentity;
}

it('returns an HTTP network failure with the actual approved local commit observation', async () => {
  const t = await setup();
  const server = createServer();
  cleanups.push(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture TCP address');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.git(t.repo, 'config', 'http.proxy', '');
  await t.git(
    t.repo,
    'remote',
    'set-url',
    'upstream',
    `http://127.0.0.1:${address.port}/org/sdk.git`
  );
  expect(await t.run()).toMatchObject({
    success: false,
    error: {
      type: 'network_error',
      observation: {
        beforeOid: t.before,
        afterOid: t.before,
        upstreamOid: null,
        remoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    },
  });
});

async function setup() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'emdash-baseline-sync-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const repo = path.join(dir, 'checkout');
  const upstream = path.join(dir, 'upstream.git');
  const fork = path.join(dir, 'fork.git');
  const git = async (cwd: string, ...args: string[]) =>
    (await execute('git', args, { cwd })).stdout.trim();
  await mkdir(source);
  await git(source, 'init', '-b', 'develop');
  await git(source, 'config', 'user.name', 'Baseline test');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(source, 'code.ts'), 'export const version = 1;');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'Baseline');
  const before = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'clone', '--bare', source, upstream);
  await git(source, 'clone', '--bare', source, fork);
  await git(source, 'clone', upstream, repo);
  await git(repo, 'remote', 'rename', 'origin', 'upstream');
  await git(repo, 'remote', 'set-url', '--push', 'upstream', fork);
  await git(repo, 'config', 'user.name', 'Baseline test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'worktree', 'add', '-b', 'feature/task', path.join(dir, 'task'), 'HEAD');
  await git(repo, 'worktree', 'add', '-b', 'emdash/manage/main', path.join(dir, 'docs'), 'HEAD');
  await git(repo, 'tag', 'baseline-before');
  const input = {
    remote: 'upstream',
    upstreamRef: localBranchRefSchema.parse('refs/heads/develop'),
    baselineRef: localBranchRefSchema.parse('refs/heads/develop'),
  };
  const bound = createBoundExec({ file: 'git', cwd: repo });
  let revision = 1;
  const advance = async () => {
    revision++;
    await writeFile(path.join(source, 'code.ts'), `export const version = ${revision};`);
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', `Upstream ${revision}`);
    await git(source, 'push', upstream, 'develop');
    return git(source, 'rev-parse', 'HEAD');
  };
  // These refs belong to independent tasks and the personal fork in every scenario.
  cleanups.push(async () => {
    expect(await git(repo, 'rev-parse', 'feature/task')).toBe(before);
    expect(await git(repo, 'rev-parse', 'emdash/manage/main')).toBe(before);
    expect(await git(source, '--git-dir', fork, 'rev-parse', 'develop')).toBe(before);
    expect(await git(repo, 'rev-parse', 'baseline-before')).toBe(before);
    expect(
      await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/emdash/baseline-candidates')
    ).toBe('');
  });
  return {
    dir,
    source,
    repo,
    upstream,
    fork,
    before,
    input,
    bound,
    git,
    advance,
    run: (patch: Partial<SyncBaselineJobInput> = {}) =>
      syncBaseline(bound, identity(repo), { ...input, ...patch }, {}),
  };
}

it('fast-forwards a clean checked-out baseline from the fetch URL, preserving independent refs', async () => {
  const t = await setup();
  const target = await t.advance();
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'updated', beforeOid: t.before, upstreamOid: target, afterOid: target },
  });
  expect(await t.git(t.repo, 'rev-parse', 'HEAD')).toBe(target);
  expect(await readFile(path.join(t.repo, 'code.ts'), 'utf8')).toBe('export const version = 2;');
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'current', afterOid: target },
  });
});

it('updates an unchecked baseline without switching the active checkout or forcing a branch', async () => {
  const t = await setup();
  await t.git(t.repo, 'switch', '-c', 'local-work');
  const target = await t.advance();
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'updated', afterOid: target },
  });
  expect(await t.git(t.repo, 'branch', '--show-current')).toBe('local-work');
  expect(await t.git(t.repo, 'rev-parse', 'HEAD')).toBe(t.before);
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(target);
});

it('establishes a missing baseline without moving a different active branch', async () => {
  const t = await setup();
  await t.git(t.repo, 'switch', '-c', 'local-work');
  await t.git(t.repo, 'branch', '-d', 'develop');
  const target = await t.advance();
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'updated', beforeOid: null, afterOid: target },
  });
  expect(await t.git(t.repo, 'rev-parse', 'HEAD')).toBe(t.before);
});

it('establishes an unborn checked-out baseline using Git checkout semantics', async () => {
  const t = await setup();
  const empty = path.join(t.dir, 'empty');
  await mkdir(empty);
  await t.git(empty, 'init', '-b', 'develop');
  await t.git(empty, 'remote', 'add', 'upstream', t.upstream);
  expect(
    await syncBaseline(createBoundExec({ file: 'git', cwd: empty }), identity(empty), t.input, {})
  ).toMatchObject({
    success: true,
    data: { kind: 'updated', beforeOid: null, afterOid: t.before },
  });
  expect(await readFile(path.join(empty, 'code.ts'), 'utf8')).toBe('export const version = 1;');
});

it.each(['untracked', 'unstaged', 'staged'] as const)(
  'blocks a %s checkout and preserves its contents',
  async (kind) => {
    const t = await setup();
    await t.advance();
    const file = kind === 'untracked' ? 'personal.txt' : 'code.ts';
    await writeFile(path.join(t.repo, file), 'Keep local work');
    if (kind === 'staged') await t.git(t.repo, 'add', file);
    expect(await t.run()).toMatchObject({
      success: true,
      data: { kind: 'blocked', reason: 'checkout-dirty' },
    });
    expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
    expect(await readFile(path.join(t.repo, file), 'utf8')).toBe('Keep local work');
  }
);

it('blocks a checkout with an in-progress Git operation even when its index is clean', async () => {
  const t = await setup();
  await t.advance();
  await writeFile(path.join(t.repo, '.git', 'MERGE_HEAD'), t.before + '\n');
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'checkout-busy' },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('refuses a baseline checked out in a different worktree, including paths with spaces', async () => {
  const t = await setup();
  await t.git(t.repo, 'switch', '-c', 'local-work');
  await t.git(t.repo, 'worktree', 'add', path.join(t.dir, 'baseline checkout'), 'develop');
  await t.advance();
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'checked-out-elsewhere' },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('keeps an upstream rewrite blocked across repeated calls instead of accepting the rejected head', async () => {
  const t = await setup();
  const accepted = await t.advance();
  expect(await t.run()).toMatchObject({ success: true, data: { kind: 'updated' } });
  await t.git(t.source, 'reset', '--hard', t.before);
  await writeFile(path.join(t.source, 'replacement.ts'), 'Unrelated upstream direction');
  await t.git(t.source, 'add', '.');
  await t.git(t.source, 'commit', '-m', 'Replace upstream history');
  await t.git(t.source, 'push', '--force', t.upstream, 'develop');
  for (const _attempt of [1, 2]) {
    expect(await t.run()).toMatchObject({
      success: true,
      data: { kind: 'blocked', reason: 'upstream-rewritten', previousUpstreamOid: accepted },
    });
  }
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(accepted);
});

it.each(['local-ahead', 'diverged'] as const)('preserves a %s local baseline', async (reason) => {
  const t = await setup();
  await writeFile(path.join(t.repo, 'custom.ts'), 'Local customization');
  await t.git(t.repo, 'add', '.');
  await t.git(t.repo, 'commit', '-m', 'Local customization');
  const local = await t.git(t.repo, 'rev-parse', 'HEAD');
  if (reason === 'diverged') await t.advance();
  expect(await t.run()).toMatchObject({ success: true, data: { kind: 'blocked', reason } });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(local);
});

it('reports an unavailable remote without changing a usable local baseline', async () => {
  const t = await setup();
  await t.git(t.repo, 'remote', 'set-url', 'upstream', path.join(t.dir, 'missing.git'));
  expect(await t.run()).toMatchObject({
    success: false,
    error: {
      type: 'remote_not_found',
      observation: { beforeOid: t.before, afterOid: t.before, upstreamOid: null },
    },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('rejects management refs, symbolic baseline refs, and a stale remote identity before fetching', async () => {
  const t = await setup();
  const record = vi.spyOn(t.bound, 'exec');
  expect(
    await t.run({ baselineRef: localBranchRefSchema.parse('refs/heads/emdash/manage/main') })
  ).toMatchObject({ success: true, data: { kind: 'blocked', reason: 'management-branch' } });
  expect(await t.run({ expectedRemoteFingerprint: '0'.repeat(64) })).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'remote-changed' },
  });
  await t.git(t.repo, 'symbolic-ref', 'refs/heads/baseline-alias', 'refs/heads/feature/task');
  expect(
    await t.run({ baselineRef: localBranchRefSchema.parse('refs/heads/baseline-alias') })
  ).toMatchObject({ success: true, data: { kind: 'blocked', reason: 'symbolic-baseline' } });
  expect(record.mock.calls.some(([args]) => args.includes('fetch'))).toBe(false);
});

it('rechecks the fetch destination before accepting or updating a baseline', async () => {
  const t = await setup();
  await t.advance();
  const exec = t.bound.exec.bind(t.bound);
  vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (args[0] === 'fetch') await t.git(t.repo, 'remote', 'set-url', 'upstream', t.fork);
    return result;
  });
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'remote-changed' },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('rechecks local work after fetch and retains it instead of stashing or resetting', async () => {
  const t = await setup();
  await t.advance();
  const exec = t.bound.exec.bind(t.bound);
  vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (args[0] === 'fetch') await writeFile(path.join(t.repo, 'code.ts'), 'Concurrent local edit');
    return result;
  });
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'checkout-dirty' },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
  expect(await readFile(path.join(t.repo, 'code.ts'), 'utf8')).toBe('Concurrent local edit');
});

it('retains the last observed upstream even when a dirty checkout prevented the local update', async () => {
  const t = await setup();
  const observed = await t.advance();
  await writeFile(path.join(t.repo, 'personal.txt'), 'Local work');
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'checkout-dirty' },
  });
  await t.git(t.source, 'reset', '--hard', t.before);
  await t.git(t.source, 'push', '--force', t.upstream, 'develop');
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'upstream-rewritten', previousUpstreamOid: observed },
  });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('does not replace an unreadable observation checkpoint with an apparently initial observation', async () => {
  const t = await setup();
  await t.run();
  const checkpoint = await t.git(
    t.repo,
    'for-each-ref',
    '--format=%(refname)',
    'refs/emdash/baseline-observations'
  );
  const blob = await t.git(t.repo, 'hash-object', '-w', 'code.ts');
  await t.git(t.repo, 'update-ref', checkpoint, blob);
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'history-unavailable' },
  });
  expect(await t.git(t.repo, 'rev-parse', checkpoint)).toBe(blob);
});

it('rejects a symbolic checkpoint without following it into a task ref', async () => {
  const t = await setup();
  await t.run();
  const checkpoint = await t.git(
    t.repo,
    'for-each-ref',
    '--format=%(refname)',
    'refs/emdash/baseline-observations'
  );
  await t.git(t.repo, 'symbolic-ref', checkpoint, 'refs/heads/feature/task');
  await t.advance();
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'symbolic-checkpoint' },
  });
});

it('cancels a fetch without updating the baseline or leaving a candidate ref', async () => {
  const t = await setup();
  await t.advance();
  const controller = new AbortController();
  const exec = t.bound.exec.bind(t.bound);
  vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (args[0] === 'fetch') controller.abort(new Error('Stop synchronization'));
    return result;
  });
  await expect(
    syncBaseline(t.bound, identity(t.repo), t.input, { signal: controller.signal })
  ).rejects.toThrow();
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('ignores a configured fetch refspec that would otherwise target an independent task branch', async () => {
  const t = await setup();
  const target = await t.advance();
  await t.git(
    t.repo,
    'config',
    '--replace-all',
    'remote.upstream.fetch',
    '+refs/heads/develop:refs/heads/feature/task'
  );
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'updated', afterOid: target },
  });
});

it('lets Git refuse an ignored-file collision rather than overwrite local contents during fast-forward', async () => {
  const t = await setup();
  await writeFile(path.join(t.repo, '.git', 'info', 'exclude'), 'personal.txt\n');
  await writeFile(path.join(t.repo, 'personal.txt'), 'Private local content');
  await writeFile(path.join(t.source, 'personal.txt'), 'Tracked upstream content');
  await t.git(t.source, 'add', '.');
  await t.git(t.source, 'commit', '-m', 'Track a colliding path');
  await t.git(t.source, 'push', t.upstream, 'develop');
  expect(await t.run()).toMatchObject({ success: false, error: { type: 'git_error' } });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
  expect(await readFile(path.join(t.repo, 'personal.txt'), 'utf8')).toBe('Private local content');
  await rm(path.join(t.repo, 'personal.txt'));
  expect(await t.run()).toMatchObject({ success: true, data: { kind: 'updated' } });
});

it.skipIf(process.platform === 'win32')(
  'distinguishes native fetch destinations that differ by a trailing space',
  async () => {
    const t = await setup();
    const different = t.upstream + ' ';
    await t.git(t.source, 'clone', '--bare', t.source, different);
    const expectedRemoteFingerprint = createHash('sha256').update(t.upstream).digest('hex');
    await t.git(t.repo, 'remote', 'set-url', 'upstream', different);
    expect(await t.run({ expectedRemoteFingerprint })).toMatchObject({
      success: true,
      data: { kind: 'blocked', reason: 'remote-changed' },
    });
  }
);

it('does not bypass a checkout created after inspection when updating an unchecked baseline', async () => {
  const t = await setup();
  await t.git(t.repo, 'switch', '-c', 'local-work');
  await t.advance();
  const exec = t.bound.exec.bind(t.bound);
  vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    if (args.includes('fetch') && args.includes(path.join(t.repo, '.git')))
      await t.git(t.repo, 'worktree', 'add', path.join(t.dir, 'concurrent-baseline'), 'develop');
    return exec(args, options);
  });
  expect(await t.run()).toMatchObject({ success: false });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(t.before);
});

it('does not force over a local commit created after inspection', async () => {
  const t = await setup();
  await t.git(t.repo, 'switch', '-c', 'local-work');
  await t.advance();
  const concurrent = await t.git(
    t.repo,
    'commit-tree',
    'HEAD^{tree}',
    '-p',
    t.before,
    '-m',
    'Concurrent local commit'
  );
  const exec = t.bound.exec.bind(t.bound);
  vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    if (args.includes('fetch') && args.includes(path.join(t.repo, '.git')))
      await t.git(t.repo, 'update-ref', 'refs/heads/develop', concurrent, t.before);
    return exec(args, options);
  });
  expect(await t.run()).toMatchObject({ success: false });
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(concurrent);
});

it('recovers an interrupted completed fast-forward by observing the resulting commit on retry', async () => {
  const t = await setup();
  const target = await t.advance();
  const controller = new AbortController();
  const exec = t.bound.exec.bind(t.bound);
  const spy = vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (args.includes('merge')) controller.abort(new Error('Lost completion after fast-forward'));
    return result;
  });
  await expect(
    syncBaseline(t.bound, identity(t.repo), t.input, { signal: controller.signal })
  ).rejects.toThrow();
  expect(await t.git(t.repo, 'rev-parse', 'develop')).toBe(target);
  spy.mockRestore();
  expect(await t.run()).toMatchObject({
    success: true,
    data: { kind: 'current', afterOid: target },
  });
});

it('reports the actual local commit when a concurrent commit invalidates the prepared baseline', async () => {
  const t = await setup();
  await t.advance();
  let concurrent: string | undefined;
  const exec = t.bound.exec.bind(t.bound);
  vi.spyOn(t.bound, 'exec').mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (args[0] === 'fetch') {
      await t.git(t.repo, 'commit', '--allow-empty', '-m', 'Concurrent user commit');
      concurrent = await t.git(t.repo, 'rev-parse', 'HEAD');
    }
    return result;
  });
  const result = await t.run();
  expect(concurrent).toBeDefined();
  expect(result).toMatchObject({
    success: true,
    data: { kind: 'blocked', reason: 'local-changed', beforeOid: t.before, afterOid: concurrent },
  });
});

it('invalidates the live HEAD projection when cancellation arrives after a completed fast-forward', async () => {
  const t = await setup();
  const target = await t.advance();
  const abort = new AbortController();
  const wrap = (bound: BoundExec): BoundExec => {
    const execute = bound.exec.bind(bound);
    const withCwd = bound.withCwd.bind(bound);
    bound.withCwd = (cwd) => wrap(withCwd(cwd));
    bound.exec = async (args, options) => {
      const result = await execute(args, options);
      if (args.includes('merge')) abort.abort(new Error('Completion was interrupted'));
      return result;
    };
    return bound;
  };
  const runtime = new GitRuntime({
    exec: wrap(createBoundExec({ file: 'git', cwd: t.repo })),
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
  const git = client(gitContract, connect(transport.left));
  const selector = { checkout: hostPath(t.repo) };
  const projection = git.checkout.model.state(selector, 'head');
  expect((await projection.snapshot()).data).toMatchObject({ oid: t.before });
  await expect(
    runtime.checkout.syncBaseline(
      { ...t.input, ...selector },
      {
        jobId: 'interrupted-baseline',
        signal: abort.signal,
        progress: () => {},
      }
    )
  ).rejects.toThrow();
  expect((await projection.snapshot()).data).toMatchObject({ oid: target });
});
