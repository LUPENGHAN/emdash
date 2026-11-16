import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { PortableRelativePath } from '#primitives/path/api';
import { localBranchRefSchema, type CheckoutStatusState } from '#runtimes/git/api';
import type { CheckoutIdentity } from '#runtimes/git/node/allocation/identity';
import { gitPath } from '#runtimes/git/node/testing/paths';
import { createBoundExec } from '#services/exec/api';
import { GitCheckout } from './git-checkout';

const execFileAsync = promisify(execFile);

const quotedPaths = [
  'café.txt',
  ' leading.txt',
  ...(process.platform === 'win32'
    ? []
    : [
        'literal {old => new}.txt',
        'tab\tname.txt',
        'line\nname.txt',
        'trailing.txt ',
        'quote"name.txt',
        'back\\slash.txt',
      ]),
];

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'emdash-git-checkout-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await writeFile(path.join(repo, 'tracked.txt'), 'before\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
  return realpath(repo);
}

async function makeCheckout(existingRepo?: string) {
  const repo = existingRepo ?? (await makeRepo());
  const gitDir = path.join(repo, '.git');
  const identity = {
    repositoryId: gitDir,
    objectStoreId: path.join(gitDir, 'objects'),
    checkoutId: JSON.stringify([repo, gitDir]),
    checkoutRoot: repo,
    gitDir,
    gitCommonDir: gitDir,
    objectStoreDir: path.join(gitDir, 'objects'),
  } as CheckoutIdentity;
  const checkout = new GitCheckout({
    identity,
    exec: createBoundExec({ file: 'git', cwd: repo }),
  });
  const cleanup = async () => {
    await rm(repo, { recursive: true, force: true });
  };
  return { repo, checkout, cleanup };
}

function openCheckout(repo: string) {
  const calls: string[][] = [];
  const gitDir = path.join(repo, '.git');
  const identity = {
    repositoryId: gitDir,
    objectStoreId: path.join(gitDir, 'objects'),
    checkoutId: JSON.stringify([repo, gitDir]),
    checkoutRoot: repo,
    gitDir,
    gitCommonDir: gitDir,
    objectStoreDir: path.join(gitDir, 'objects'),
  } as CheckoutIdentity;
  const bound = createBoundExec({ file: 'git', cwd: repo });
  const exec = bound.exec.bind(bound);
  const checkout = new GitCheckout({
    identity,
    exec: Object.assign(bound, {
      async exec(args: string[], options?: Parameters<typeof bound.exec>[1]) {
        calls.push([...args]);
        return exec(args, options);
      },
    }),
  });
  return { checkout, calls };
}

const originRemote = { name: 'origin', url: 'https://example.com/repo.git' };

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo });
  return stdout.trim();
}

async function showRef(repo: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

async function gitConfig(repo: string, key: string): Promise<string | null> {
  try {
    return await git(repo, ['config', '--get', key]);
  } catch {
    return null;
  }
}

function okStatus(model: CheckoutStatusState): Extract<CheckoutStatusState, { kind: 'ok' }> {
  expect(model.kind).toBe('ok');
  if (model.kind !== 'ok') throw new Error(`expected ok status, got ${model.kind}`);
  return model;
}

describe('GitCheckout', () => {
  it('keeps the canonical branch name when a tag has the same name', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await execFileAsync('git', ['tag', 'main'], { cwd: repo });

      await expect(checkout.getHead()).resolves.toMatchObject({
        kind: 'branch',
        ref: 'refs/heads/main',
        upstream: { kind: 'none' },
      });
    } finally {
      await cleanup();
    }
  });

  it('distinguishes remote upstream identity from tracking resolution', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const remote = await mkdtemp(path.join(tmpdir(), 'emdash-git-checkout-remote-'));
    try {
      await execFileAsync('git', ['init', '--bare'], { cwd: remote });
      await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: repo });

      await expect(checkout.publish('origin')).resolves.toMatchObject({
        success: true,
      });
      await expect(checkout.getHead()).resolves.toMatchObject({
        kind: 'branch',
        ref: 'refs/heads/main',
        upstream: {
          kind: 'remote',
          remote: 'origin',
          mergeRef: 'refs/heads/main',
          tracking: {
            kind: 'resolved',
            ref: 'refs/remotes/origin/main',
            ahead: 0,
            behind: 0,
          },
        },
      });

      await execFileAsync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo });
      await execFileAsync('git', ['config', 'branch.main.merge', 'refs/pull/7/head'], {
        cwd: repo,
      });
      await expect(checkout.getHead()).resolves.toMatchObject({
        kind: 'branch',
        upstream: {
          kind: 'remote',
          remote: 'origin',
          mergeRef: 'refs/pull/7/head',
          tracking: { kind: 'unresolved' },
        },
      });
    } finally {
      await cleanup();
      await rm(remote, { recursive: true, force: true });
    }
  });

  it('represents a local branch as a resolved upstream', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await execFileAsync('git', ['branch', 'other'], { cwd: repo });
      await execFileAsync('git', ['config', 'branch.main.remote', '.'], { cwd: repo });
      await execFileAsync('git', ['config', 'branch.main.merge', 'refs/heads/other'], {
        cwd: repo,
      });

      await expect(checkout.getHead()).resolves.toMatchObject({
        kind: 'branch',
        ref: 'refs/heads/main',
        upstream: {
          kind: 'local',
          mergeRef: 'refs/heads/other',
          tracking: { kind: 'resolved', ref: 'refs/heads/other' },
        },
      });
    } finally {
      await cleanup();
    }
  });

  it('reads status and head and tracks the staging lifecycle', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      const initialStatus = okStatus(await checkout.getStatus());
      expect(initialStatus.entries).toEqual({});
      expect(initialStatus.operation).toBe('none');
      expect(await checkout.getHead()).toMatchObject({ kind: 'branch', ref: 'refs/heads/main' });

      const trackedPath = gitPath('tracked.txt');
      await writeFile(path.join(repo, trackedPath), 'after\n', 'utf8');
      const dirty = okStatus(await checkout.getStatus());
      expect(dirty.entries[trackedPath]?.worktree).toBe('modified');

      const stageResult = await checkout.stage([trackedPath]);
      expect(stageResult.success).toBe(true);
      const staged = okStatus(await checkout.getStatus());
      expect(staged.entries[trackedPath]).toMatchObject({
        index: 'modified',
        worktree: 'unmodified',
      });
      expect(staged.summary).toMatchObject({ staged: 1, unstaged: 0 });

      const previousHead = await checkout.getHead();
      const previousOid = previousHead.kind === 'branch' ? previousHead.oid : '';
      const commitResult = await checkout.commit('update tracked');
      expect(commitResult.success).toBe(true);
      if (!commitResult.success) throw new Error('commit failed');
      expect(commitResult.data.hash).toMatch(/^[0-9a-f]{40}$/);

      const afterCommit = okStatus(await checkout.getStatus());
      expect(afterCommit.entries).toEqual({});
      expect(await checkout.getHead()).toMatchObject({
        kind: 'branch',
        ref: 'refs/heads/main',
        oid: commitResult.data.hash,
      });
      expect(commitResult.data.hash).not.toBe(previousOid);
    } finally {
      await cleanup();
    }
  });

  it('models untracked files and conflict-free summaries', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'fresh.txt'), 'hello\n', 'utf8');
      const model = okStatus(await checkout.getStatus());
      expect(model.entries[gitPath('fresh.txt')]).toMatchObject({
        index: 'untracked',
        worktree: 'untracked',
        isConflicted: false,
      });
      expect(model.summary).toMatchObject({ untracked: 1, staged: 0, unstaged: 0, conflicted: 0 });
    } finally {
      await cleanup();
    }
  });

  it('separates staged and unstaged changes', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'staged\n', 'utf8');
      await checkout.stage(['tracked.txt']);
      await writeFile(path.join(repo, 'tracked.txt'), 'unstaged\n', 'utf8');

      await expect(checkout.getChangedFiles({ kind: 'staged' })).resolves.toEqual([
        expect.objectContaining({ path: gitPath('tracked.txt'), additions: 1, deletions: 1 }),
      ]);
      await expect(checkout.getChangedFiles({ kind: 'unstaged' })).resolves.toEqual([
        expect.objectContaining({ path: gitPath('tracked.txt'), additions: 1, deletions: 1 }),
      ]);
    } finally {
      await cleanup();
    }
  });

  it('rejects paths outside its checkout root', async () => {
    const { checkout, cleanup } = await makeCheckout();
    try {
      await expect(
        checkout.getFile({
          path: '../secret.txt' as PortableRelativePath,
          source: { kind: 'index' },
        })
      ).rejects.toThrow('outside checkout');
      await expect(checkout.stage(['../secret.txt'])).resolves.toMatchObject({
        success: false,
        error: { type: 'git_error', message: expect.stringContaining('outside checkout') },
      });
    } finally {
      await cleanup();
    }
  });

  it.each(['staged', 'commit', 'root commit'] as const)(
    'preserves quoted paths and reads their content from a %s',
    async (target) => {
      const { repo, checkout, cleanup } = await makeCheckout();
      try {
        await execFileAsync('git', ['config', 'core.quotepath', 'true'], { cwd: repo });
        for (const filePath of quotedPaths) {
          await writeFile(path.join(repo, filePath), `content for ${filePath}\n`, 'utf8');
        }
        await execFileAsync('git', ['add', '--', ...quotedPaths], { cwd: repo });

        const expected = quotedPaths.map((filePath) => ({
          path: gitPath(filePath),
          status: 'added',
          additions: filePath.includes('\n') ? 2 : 1,
          deletions: 0,
        }));
        if (target === 'staged') {
          const changes = await checkout.getChangedFiles({ kind: 'staged' });
          expect(changes).toHaveLength(expected.length);
          expect(changes).toEqual(expect.arrayContaining(expected));
          for (const change of changes) {
            await expect(
              checkout.getFile({ path: change.path, source: { kind: 'index' } })
            ).resolves.toEqual({
              success: true,
              data: { content: `content for ${change.path}\n` },
            });
          }
          return;
        }

        await execFileAsync(
          'git',
          ['commit', ...(target === 'root commit' ? ['--amend'] : []), '-m', 'add quoted paths'],
          { cwd: repo }
        );
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
        const hash = stdout.trim();
        const files = await checkout.getCommitFiles(hash);
        if (target === 'root commit') {
          expected.push({
            path: gitPath('tracked.txt'),
            status: 'added',
            additions: 1,
            deletions: 0,
          });
        }
        expect(files).toHaveLength(expected.length);
        expect(files).toEqual(expect.arrayContaining(expected));
        for (const file of files) {
          await expect(
            checkout.getFile({
              path: file.path,
              source: { kind: 'revision', revision: { kind: 'commit', sha: hash } },
            })
          ).resolves.toEqual({
            success: true,
            data: {
              content: file.path === 'tracked.txt' ? 'before\n' : `content for ${file.path}\n`,
            },
          });
        }
      } finally {
        await cleanup();
      }
    }
  );

  it('preserves quoted paths and line counts in unstaged changes', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await execFileAsync('git', ['config', 'core.quotepath', 'true'], { cwd: repo });
      for (const filePath of quotedPaths) {
        await writeFile(path.join(repo, filePath), 'before\n', 'utf8');
      }
      await execFileAsync('git', ['add', '--', ...quotedPaths], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add quoted paths'], { cwd: repo });
      for (const filePath of quotedPaths) {
        await writeFile(path.join(repo, filePath), 'after\nextra\n', 'utf8');
      }

      const changes = await checkout.getChangedFiles({ kind: 'unstaged' });
      expect(changes).toHaveLength(quotedPaths.length);
      expect(changes).toEqual(
        expect.arrayContaining(
          quotedPaths.map((filePath) => ({
            path: gitPath(filePath),
            status: 'modified',
            additions: 2,
            deletions: 1,
          }))
        )
      );
      for (const change of changes) {
        await expect(
          checkout.getFile({ path: change.path, source: { kind: 'head' } })
        ).resolves.toEqual({ success: true, data: { content: 'before\n' } });
      }
    } finally {
      await cleanup();
    }
  });

  it('lists merge commit files against only the first parent', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: repo });
    try {
      await writeFile(path.join(repo, 'deleted file.txt'), 'delete me\n');
      await writeFile(path.join(repo, 'old name.txt'), 'one\ntwo\nthree\nfour\nfive\n');
      await git('add', '.');
      await git('commit', '--amend', '--no-edit');
      await git('checkout', '-b', 'topic');
      await writeFile(path.join(repo, 'added café file.txt'), 'from topic\n');
      await writeFile(path.join(repo, 'tracked.txt'), 'after\nextra\n');
      await git('rm', 'deleted file.txt');
      await git('mv', 'old name.txt', 'new name.txt');
      await git('add', '.');
      await git('commit', '-m', 'topic changes');
      await git('checkout', 'main');
      await writeFile(path.join(repo, 'main only.txt'), 'first parent change\n');
      await git('add', '.');
      await git('commit', '-m', 'main changes');
      await git('merge', '--no-ff', 'topic', '-m', 'merge topic');
      const { stdout: mergeHash } = await git('rev-parse', 'HEAD');
      await expect(checkout.getCommitFiles(mergeHash.trim())).resolves.toEqual([
        { path: gitPath('added café file.txt'), status: 'added', additions: 1, deletions: 0 },
        { path: gitPath('deleted file.txt'), status: 'deleted', additions: 0, deletions: 1 },
        { path: gitPath('new name.txt'), status: 'added', additions: 5, deletions: 0 },
        { path: gitPath('old name.txt'), status: 'deleted', additions: 0, deletions: 5 },
        { path: gitPath('tracked.txt'), status: 'modified', additions: 2, deletions: 1 },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('returns no files for a merge with an empty first-parent diff', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: repo });
    try {
      await git('checkout', '-b', 'topic');
      await writeFile(path.join(repo, 'topic.txt'), 'second parent change\n');
      await git('add', '.');
      await git('commit', '-m', 'topic changes');
      await git('checkout', 'main');
      await git('merge', '--no-ff', '-s', 'ours', 'topic', '-m', 'keep first parent tree');
      const { stdout: mergeHash } = await git('rev-parse', 'HEAD');
      await expect(checkout.getCommitFiles(mergeHash.trim())).resolves.toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('does not treat a shallow commit with an unavailable parent as a root', async () => {
    const repo = await makeRepo();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'after\n');
      await execFileAsync('git', ['commit', '-am', 'modify tracked file'], { cwd: repo });
      const shallowRepo = path.join(repo, 'shallow');
      await execFileAsync('git', ['clone', '--depth=1', pathToFileURL(repo).href, shallowRepo]);
      const { checkout } = await makeCheckout(shallowRepo);
      const { stdout: hash } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: shallowRepo,
      });

      await expect(checkout.getCommitFiles(hash.trim())).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'uses the exact destination path and line counts for an edited rename',
    async () => {
      const { repo, checkout, cleanup } = await makeCheckout();
      const oldPath = 'old café {before => after}.txt';
      const newPath = 'new café {before => after}.txt';
      try {
        await execFileAsync('git', ['config', 'core.quotepath', 'true'], { cwd: repo });
        await execFileAsync('git', ['config', 'diff.renames', 'true'], { cwd: repo });
        await writeFile(path.join(repo, oldPath), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
        await execFileAsync('git', ['add', '--', oldPath], { cwd: repo });
        await execFileAsync('git', ['commit', '-m', 'add rename source'], { cwd: repo });
        await rename(path.join(repo, oldPath), path.join(repo, newPath));
        await writeFile(path.join(repo, newPath), 'one\ntwo\nthree\nfour\nchanged\n', 'utf8');
        await execFileAsync('git', ['add', '-A'], { cwd: repo });

        const changes = await checkout.getChangedFiles({ kind: 'staged' });
        expect(changes).toEqual([
          {
            path: gitPath(newPath),
            originalPath: gitPath(oldPath),
            status: 'renamed',
            additions: 1,
            deletions: 1,
          },
        ]);
        await expect(
          checkout.getFile({ path: changes[0].path, source: { kind: 'index' } })
        ).resolves.toEqual({
          success: true,
          data: { content: 'one\ntwo\nthree\nfour\nchanged\n' },
        });
      } finally {
        await cleanup();
      }
    }
  );

  it('reads one-shot file content for head, index, and revision sources', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'staged\n', 'utf8');
      await checkout.stage(['tracked.txt']);

      await expect(
        checkout.getFile({ path: gitPath('tracked.txt'), source: { kind: 'head' } })
      ).resolves.toEqual({ success: true, data: { content: 'before\n' } });
      await expect(
        checkout.getFile({ path: gitPath('tracked.txt'), source: { kind: 'index' } })
      ).resolves.toEqual({ success: true, data: { content: 'staged\n' } });
      await expect(
        checkout.getFile({
          path: gitPath('tracked.txt'),
          source: {
            kind: 'revision',
            revision: { kind: 'branch', branch: { type: 'local', branch: 'main' } },
          },
        })
      ).resolves.toEqual({ success: true, data: { content: 'before\n' } });

      await expect(
        checkout.getFile({ path: gitPath('missing.txt'), source: { kind: 'head' } })
      ).resolves.toEqual({ success: true, data: { content: null } });
      await expect(
        checkout.getFile({ path: gitPath('missing.txt'), source: { kind: 'index' } })
      ).resolves.toEqual({ success: true, data: { content: null } });

      await writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
      await checkout.stage(['binary.bin']);
      await expect(
        checkout.getFile({ path: gitPath('binary.bin'), source: { kind: 'index' } })
      ).resolves.toMatchObject({ success: false, error: { type: 'git_error' } });
    } finally {
      await cleanup();
    }
  });

  it('reads log, single commits, commit files, and blame', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'after\n', 'utf8');
      await checkout.stageAll();
      const commitResult = await checkout.commit('second commit');
      if (!commitResult.success) throw new Error('commit failed');

      const log = await checkout.getLog();
      expect(log.commits).toHaveLength(2);
      expect(log.totalCount).toBe(2);
      expect(log.commits[0]).toMatchObject({ subject: 'second commit', isPushed: false });

      const commit = await checkout.getCommit(commitResult.data.hash);
      expect(commit).toMatchObject({ hash: commitResult.data.hash, subject: 'second commit' });
      await expect(checkout.getCommit('0'.repeat(40))).resolves.toBeNull();

      const files = await checkout.getCommitFiles(commitResult.data.hash);
      expect(files).toEqual([
        expect.objectContaining({
          path: gitPath('tracked.txt'),
          additions: 1,
          deletions: 1,
        }),
      ]);

      const blameResult = await checkout.blame('tracked.txt');
      expect(blameResult.success).toBe(true);
      if (!blameResult.success) throw new Error('blame failed');
      expect(blameResult.data.hunks).toEqual([
        expect.objectContaining({
          oid: commitResult.data.hash,
          author: 'Test User',
          authorEmail: 'test@example.com',
          summary: 'second commit',
          startLine: 1,
          lineCount: 1,
        }),
      ]);
    } finally {
      await cleanup();
    }
  });

  it('classifies live Git file content as text, binary, or missing', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await expect(
        checkout.getFileContent({ path: gitPath('tracked.txt'), source: { kind: 'head' } })
      ).resolves.toMatchObject({
        kind: 'text',
        content: 'before\n',
        oid: expect.stringMatching(/^[0-9a-f]{40}$/u),
      });
      await expect(
        checkout.getFileContent({ path: gitPath('missing.txt'), source: { kind: 'head' } })
      ).resolves.toEqual({
        kind: 'missing',
        path: 'missing.txt',
        source: { kind: 'head' },
      });

      await writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
      await execFileAsync('git', ['add', 'binary.bin'], { cwd: repo });
      await expect(
        checkout.getFileContent({ path: gitPath('binary.bin'), source: { kind: 'index' } })
      ).resolves.toMatchObject({ kind: 'binary', byteSize: 3 });
    } finally {
      await cleanup();
    }
  });

  it('distinguishes a missing revision from a missing path for text and downloads', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const valid = { kind: 'revision', revision: { kind: 'commit', sha: head } } as const;
      const missing = {
        kind: 'revision',
        revision: { kind: 'commit', sha: '0'.repeat(40) },
      } as const;
      await expect(
        checkout.getFileContent({ path: gitPath('missing.txt'), source: valid })
      ).resolves.toMatchObject({ kind: 'missing' });
      await expect(
        checkout.getFileContent({ path: gitPath('tracked.txt'), source: missing })
      ).resolves.toMatchObject({ kind: 'unavailable' });
      await expect(
        checkout.download({ path: gitPath('missing.png'), source: valid })
      ).resolves.toMatchObject({ success: false, error: { type: 'missing' } });
      await expect(
        checkout.download({ path: gitPath('tracked.txt'), source: missing })
      ).resolves.toMatchObject({ success: false, error: { type: 'git_error' } });
    } finally {
      await cleanup();
    }
  });

  it('reports a missing blob or tree as unavailable for a pinned revision', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const source = { kind: 'revision', revision: { kind: 'commit', sha: head } } as const;
      const blob = await git(repo, ['rev-parse', 'HEAD:tracked.txt']);
      await unlink(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
      await expect(
        checkout.getFileContent({ path: gitPath('tracked.txt'), source })
      ).resolves.toMatchObject({ kind: 'unavailable' });
      await expect(
        checkout.download({ path: gitPath('tracked.txt'), source })
      ).resolves.toMatchObject({ success: false, error: { type: 'git_error' } });
      const tree = await git(repo, ['rev-parse', 'HEAD^{tree}']);
      await unlink(path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
      await expect(
        checkout.getFileContent({ path: gitPath('missing.txt'), source })
      ).resolves.toMatchObject({ kind: 'unavailable' });
    } finally {
      await cleanup();
    }
  });

  it('compares diverged commits from their merge base and rejects ambiguous ancestry', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      const root = await git(repo, ['rev-parse', 'HEAD']);
      const blob = await git(repo, ['rev-parse', 'HEAD:tracked.txt']);
      expect((await checkout.getMergeBase(blob, root)).success).toBe(false);
      await git(repo, ['tag', '-a', 'annotated', root, '-m', 'tag']);
      const tag = await git(repo, ['rev-parse', 'refs/tags/annotated']);
      expect((await checkout.getMergeBase(tag, root)).success).toBe(false);
      await git(repo, ['switch', '-c', 'task']);
      await writeFile(path.join(repo, 'task.txt'), 'task\n');
      await git(repo, ['add', 'task.txt']);
      await git(repo, ['commit', '-m', 'task']);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['switch', 'main']);
      await writeFile(path.join(repo, 'base.txt'), 'base\n');
      await git(repo, ['add', 'base.txt']);
      await git(repo, ['commit', '-m', 'base']);
      const base = await git(repo, ['rev-parse', 'HEAD']);
      expect(await checkout.getMergeBase(base, head)).toEqual({
        success: true,
        data: { oid: root },
      });
      const changes = await checkout.getChangedFiles({
        base: { kind: 'commit', sha: base },
        head: { kind: 'commit', sha: head },
      });
      expect(changes.map((change) => change.path)).toEqual([gitPath('task.txt')]);
      expect((await checkout.getMergeBase('0'.repeat(40), head)).success).toBe(false);
      const tree = await git(repo, ['rev-parse', `${root}^{tree}`]);
      const unrelated = await git(repo, ['commit-tree', tree, '-m', 'unrelated']);
      expect((await checkout.getMergeBase(unrelated, head)).success).toBe(false);
      const first = await git(repo, ['commit-tree', tree, '-p', root, '-m', 'first']);
      const second = await git(repo, ['commit-tree', tree, '-p', root, '-m', 'second']);
      const left = await git(repo, ['commit-tree', tree, '-p', first, '-p', second, '-m', 'left']);
      const right = await git(repo, [
        'commit-tree',
        tree,
        '-p',
        second,
        '-p',
        first,
        '-m',
        'right',
      ]);
      expect((await checkout.getMergeBase(left, right)).success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('finds a merge base in a SHA-256 repository', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'emdash-git-sha256-'));
    try {
      await execFileAsync('git', ['init', '--object-format=sha256', '-b', 'main'], { cwd: repo });
      await git(repo, ['config', 'user.email', 'test@example.com']);
      await git(repo, ['config', 'user.name', 'Test User']);
      await writeFile(path.join(repo, 'file.txt'), 'content\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-m', 'initial']);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const { checkout } = await makeCheckout(repo);
      expect(head).toHaveLength(64);
      expect(await checkout.getMergeBase(head, head)).toEqual({
        success: true,
        data: { oid: head },
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reverts working-tree changes and cleans untracked files', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'dirty\n', 'utf8');
      await writeFile(path.join(repo, 'junk.txt'), 'junk\n', 'utf8');
      const revertResult = await checkout.revertAll({ includeUntracked: true });
      expect(revertResult.success).toBe(true);
      const model = okStatus(await checkout.getStatus());
      expect(model.entries).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it('keeps untracked files when includeUntracked is false', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'dirty\n', 'utf8');
      await writeFile(path.join(repo, 'junk.txt'), 'junk\n', 'utf8');
      const revertResult = await checkout.revertAll({ includeUntracked: false });
      expect(revertResult.success).toBe(true);
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
      await expect(readFile(path.join(repo, 'junk.txt'), 'utf8')).resolves.toBe('junk\n');
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps untracked symlinks while cleaning other untracked files',
    async () => {
      const { repo, checkout, cleanup } = await makeCheckout();
      try {
        await writeFile(path.join(repo, 'junk.txt'), 'junk\n', 'utf8');
        await symlink(tmpdir(), path.join(repo, 'linked'));
        const revertResult = await checkout.revertAll({ includeUntracked: true });
        expect(revertResult.success).toBe(true);
        await expect(readFile(path.join(repo, 'junk.txt'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        // An untracked `node_modules`-style link survives the clean.
        const stats = await lstat(path.join(repo, 'linked'));
        expect(stats.isSymbolicLink()).toBe(true);
      } finally {
        await cleanup();
      }
    }
  );
});

describe('GitCheckout.switchBranch', () => {
  it('leaves a dirty checkout in place when git refuses the switch', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['checkout', '-b', 'other']);
      await writeFile(path.join(repo, 'tracked.txt'), 'other\n', 'utf8');
      await git(repo, ['commit', '-am', 'other']);
      await git(repo, ['checkout', 'main']);
      await writeFile(path.join(repo, 'tracked.txt'), 'third\n', 'utf8');

      const refused = await checkout.switchBranch({ type: 'local', branch: 'other' });
      expect(refused.success).toBe(false);
      if (refused.success) throw new Error('expected git to refuse the switch');
      expect(refused.error.type).toBe('git_error');
      expect(refused.error.message.toLowerCase()).toMatch(/overwritten|local changes/);
      await expect(checkout.getHead()).resolves.toMatchObject({ ref: 'refs/heads/main' });
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('third\n');

      await git(repo, ['checkout', '-b', 'topic']);
      await writeFile(path.join(repo, 'tracked.txt'), 'remote\n', 'utf8');
      await git(repo, ['commit', '-am', 'remote topic']);
      const topic = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', 'main']);
      await git(repo, ['branch', '-D', 'topic']);
      await git(repo, ['remote', 'add', 'origin', originRemote.url]);
      await git(repo, ['update-ref', 'refs/remotes/origin/topic', topic]);
      await writeFile(path.join(repo, 'tracked.txt'), 'third\n', 'utf8');

      const created = await checkout.switchBranch({
        type: 'remote',
        branch: 'topic',
        remote: originRemote,
      });
      expect(created.success).toBe(false);
      if (created.success) throw new Error('expected git to refuse creating the branch');
      expect(created.error.type).toBe('git_error');
      expect(await showRef(repo, 'refs/heads/topic')).toBe(false);
      await expect(checkout.getHead()).resolves.toMatchObject({ ref: 'refs/heads/main' });
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('third\n');
    } finally {
      await cleanup();
    }
  });

  it('carries a non-conflicting dirty file across a branch switch', async () => {
    const { repo, cleanup } = await makeCheckout();
    const { checkout, calls } = openCheckout(repo);
    try {
      await git(repo, ['checkout', '-b', 'other']);
      await git(repo, ['checkout', 'main']);
      await writeFile(path.join(repo, 'extra.txt'), 'keep\n', 'utf8');
      calls.length = 0;

      const result = await checkout.switchBranch({ type: 'local', branch: 'other' });
      expect(result.success).toBe(true);
      await expect(readFile(path.join(repo, 'extra.txt'), 'utf8')).resolves.toBe('keep\n');
      const argv = calls.flat();
      expect(argv).not.toContain('--force');
      expect(argv).not.toContain('-f');
      expect(argv).not.toContain('reset');
      expect(argv).not.toContain('-D');
    } finally {
      await cleanup();
    }
  });

  it('attaches a detached HEAD to the selected local branch', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['checkout', '-b', 'other']);
      await git(repo, ['checkout', 'main']);
      await git(repo, ['checkout', '--detach']);

      const result = await checkout.switchBranch({ type: 'local', branch: 'other' });
      expect(result.success).toBe(true);
      await expect(checkout.getHead()).resolves.toMatchObject({
        kind: 'branch',
        ref: 'refs/heads/other',
      });
    } finally {
      await cleanup();
    }
  });

  it('does not run checkout when HEAD is already that branch', async () => {
    const { repo, cleanup } = await makeCheckout();
    const { checkout, calls } = openCheckout(repo);
    try {
      await git(repo, ['checkout', '-b', 'feature']);
      await git(repo, ['remote', 'add', 'origin', originRemote.url]);
      await git(repo, ['update-ref', 'refs/remotes/origin/feature', 'HEAD']);
      calls.length = 0;

      const local = await checkout.switchBranch({ type: 'local', branch: 'feature' });
      const remote = await checkout.switchBranch({
        type: 'remote',
        branch: 'feature',
        remote: originRemote,
      });
      expect(local.success).toBe(true);
      expect(remote.success).toBe(true);
      expect(calls.some((args) => args[0] === 'switch' || args[0] === 'checkout')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('checks out the existing local branch for a remote ref', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['checkout', '-b', 'feature']);
      await writeFile(path.join(repo, 'tracked.txt'), 'local\n', 'utf8');
      await git(repo, ['commit', '-am', 'local feature']);
      const localOid = await git(repo, ['rev-parse', 'refs/heads/feature']);
      await git(repo, ['checkout', 'main']);
      await writeFile(path.join(repo, 'tracked.txt'), 'remote\n', 'utf8');
      await git(repo, ['commit', '-am', 'remote feature']);
      const remoteOid = await git(repo, ['rev-parse', 'HEAD']);
      expect(localOid).not.toBe(remoteOid);
      await git(repo, ['remote', 'add', 'origin', originRemote.url]);
      await git(repo, ['update-ref', 'refs/remotes/origin/feature', remoteOid]);
      const remoteBefore = await gitConfig(repo, 'branch.feature.remote');
      const mergeBefore = await gitConfig(repo, 'branch.feature.merge');

      const result = await checkout.switchBranch({
        type: 'remote',
        branch: 'feature',
        remote: originRemote,
      });
      expect(result.success).toBe(true);
      await expect(checkout.getHead()).resolves.toMatchObject({ oid: localOid });
      await expect(git(repo, ['rev-parse', 'refs/heads/feature'])).resolves.toBe(localOid);
      expect(await gitConfig(repo, 'branch.feature.remote')).toBe(remoteBefore);
      expect(await gitConfig(repo, 'branch.feature.merge')).toBe(mergeBefore);
      const listed = await git(repo, ['for-each-ref', 'refs/heads/feature']);
      expect(listed.split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('creates a tracking branch for a remote ref with no local branch', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['remote', 'add', 'origin', originRemote.url]);
      await git(repo, ['update-ref', 'refs/remotes/origin/topic', 'HEAD']);
      const remoteOid = await git(repo, ['rev-parse', 'refs/remotes/origin/topic']);
      expect(await showRef(repo, 'refs/heads/topic')).toBe(false);

      const result = await checkout.switchBranch({
        type: 'remote',
        branch: 'topic',
        remote: originRemote,
      });
      expect(result.success).toBe(true);
      await expect(checkout.getHead()).resolves.toMatchObject({ oid: remoteOid });
      expect(await gitConfig(repo, 'branch.topic.remote')).toBe('origin');
      expect(await gitConfig(repo, 'branch.topic.merge')).toBe('refs/heads/topic');
    } finally {
      await cleanup();
    }
  });

  it('does not restore a tracked path when the branch ref is absent', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await writeFile(path.join(repo, 'tracked.txt'), 'third\n', 'utf8');
      expect(await showRef(repo, 'refs/heads/tracked.txt')).toBe(false);

      const result = await checkout.switchBranch({ type: 'local', branch: 'tracked.txt' });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected a missing ref to fail');
      expect(result.error.type).toBe('git_error');
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('third\n');
      await expect(checkout.getHead()).resolves.toMatchObject({ ref: 'refs/heads/main' });
      expect(await showRef(repo, 'refs/heads/tracked.txt')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('does not create a local branch when only the remote ref exists', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['update-ref', 'refs/remotes/origin/topic', 'HEAD']);
      expect(await showRef(repo, 'refs/heads/topic')).toBe(false);
      const before = await checkout.getHead();
      expect(before.kind).toBe('branch');
      if (before.kind !== 'branch') throw new Error('expected HEAD to be a branch');

      const result = await checkout.switchBranch({ type: 'local', branch: 'topic' });
      expect(result.success).toBe(false);
      await expect(checkout.getHead()).resolves.toMatchObject({ ref: before.ref });
      expect(await showRef(repo, 'refs/heads/topic')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('checks out an option-like branch name without discarding edits', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['update-ref', 'refs/heads/--force', 'HEAD']);
      await writeFile(path.join(repo, 'tracked.txt'), 'uncommitted\n', 'utf8');

      const result = await checkout.switchBranch({ type: 'local', branch: '--force' });
      expect(result.success).toBe(true);
      await expect(checkout.getHead()).resolves.toMatchObject({ ref: 'refs/heads/--force' });
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('uncommitted\n');
    } finally {
      await cleanup();
    }
  });

  it('tracks the remote oid when a local branch is named origin/topic', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    try {
      await git(repo, ['checkout', '-b', 'origin/topic']);
      await writeFile(path.join(repo, 'tracked.txt'), 'local-name\n', 'utf8');
      await git(repo, ['commit', '-am', 'local name']);
      const localOid = await git(repo, ['rev-parse', 'refs/heads/origin/topic']);
      await git(repo, ['checkout', 'main']);
      const remoteOid = await git(repo, ['rev-parse', 'HEAD']);
      expect(localOid).not.toBe(remoteOid);
      await git(repo, ['remote', 'add', 'origin', originRemote.url]);
      await git(repo, ['update-ref', 'refs/remotes/origin/topic', remoteOid]);
      expect(await showRef(repo, 'refs/heads/topic')).toBe(false);

      const result = await checkout.switchBranch({
        type: 'remote',
        branch: 'topic',
        remote: originRemote,
      });
      expect(result.success).toBe(true);
      await expect(checkout.getHead()).resolves.toMatchObject({ oid: remoteOid });
      expect(await gitConfig(repo, 'branch.topic.remote')).toBe('origin');
      expect(await gitConfig(repo, 'branch.topic.merge')).toBe('refs/heads/topic');
      await expect(git(repo, ['rev-parse', 'refs/heads/origin/topic'])).resolves.toBe(localOid);
    } finally {
      await cleanup();
    }
  });

  it('switches only this checkout and leaves the other worktree alone', async () => {
    const { repo, checkout: mainCheckout, cleanup } = await makeCheckout();
    const parent = await mkdtemp(path.join(tmpdir(), 'emdash-git-worktree-'));
    const worktree = path.join(parent, 'wt');
    try {
      await git(repo, ['checkout', '-b', 'feature']);
      await git(repo, ['checkout', 'main']);
      await git(repo, ['branch', 'topic']);
      await git(repo, ['worktree', 'add', worktree, 'feature']);
      const worktreeRoot = await realpath(worktree);
      const { checkout: worktreeCheckout } = openCheckout(worktreeRoot);

      const switched = await worktreeCheckout.switchBranch({ type: 'local', branch: 'topic' });
      expect(switched.success).toBe(true);
      await expect(worktreeCheckout.getHead()).resolves.toMatchObject({
        ref: 'refs/heads/topic',
      });
      await expect(mainCheckout.getHead()).resolves.toMatchObject({ ref: 'refs/heads/main' });

      const worktreeHead = await worktreeCheckout.getHead();
      const mainHead = await mainCheckout.getHead();
      const refused = await worktreeCheckout.switchBranch({ type: 'local', branch: 'main' });
      expect(refused.success).toBe(false);
      if (refused.success) throw new Error('expected the occupied branch to stay put');
      expect(refused.error.type).toBe('git_error');
      expect(await worktreeCheckout.getHead()).toEqual(worktreeHead);
      expect(await mainCheckout.getHead()).toEqual(mainHead);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe('selected file commits', () => {
  it('commits literal selected paths while preserving unrelated staged changes and supports deletion', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
    try {
      const initial = await git('rev-parse', 'HEAD');
      await writeFile(path.join(repo, 'tracked.txt'), 'unrelated staged change\n');
      await checkout.stage(['tracked.txt']);
      await writeFile(path.join(repo, 'plan[1].md'), 'selected plan\n');
      await writeFile(path.join(repo, 'plan1.md'), 'unselected plan\n');
      const committed = await checkout.commitFiles({
        paths: ['plan[1].md'],
        message: 'Save selected plan',
        expectedHead: initial,
        expectedBranch: 'refs/heads/main',
      });
      expect(committed.success).toBe(true);
      if (!committed.success) throw new Error('Selected commit failed');
      expect(await git('show', 'HEAD:plan[1].md')).toBe('selected plan');
      expect(await git('show', 'HEAD:tracked.txt')).toBe('before');
      expect(await git('diff', '--cached', '--name-only')).toBe('tracked.txt');
      expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('plan1.md');
      await unlink(path.join(repo, 'plan[1].md'));
      const deleted = await checkout.commitFiles({
        paths: ['plan[1].md'],
        message: 'Delete selected plan',
        expectedHead: committed.data.hash,
        expectedBranch: 'refs/heads/main',
      });
      expect(deleted.success).toBe(true);
      expect(await git('ls-tree', '--name-only', 'HEAD')).not.toContain('plan[1].md');
      expect(await git('diff', '--cached', '--name-only')).toBe('tracked.txt');
    } finally {
      await cleanup();
    }
  });
  it('refuses stale branches, stale commits and directories before staging selected files', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
    try {
      const initial = await git('rev-parse', 'HEAD');
      await writeFile(path.join(repo, 'plan.md'), 'selected plan\n');
      const input = {
        paths: ['plan.md'],
        message: 'Save plan',
        expectedHead: initial,
        expectedBranch: 'refs/heads/main',
      };
      await expect(
        checkout.commitFiles({ ...input, expectedHead: 'a'.repeat(40) })
      ).resolves.toMatchObject({ success: false, error: { code: 'stale_ref_update' } });
      await expect(
        checkout.commitFiles({ ...input, expectedBranch: 'refs/heads/other' })
      ).resolves.toMatchObject({ success: false, error: { code: 'stale_ref_update' } });
      await expect(checkout.commitFiles({ ...input, paths: ['.git'] })).resolves.toMatchObject({
        success: false,
      });
      await expect(
        checkout.commitFiles({ ...input, paths: ['../plan.md'] })
      ).resolves.toMatchObject({ success: false });
      expect(await git('rev-parse', 'HEAD')).toBe(initial);
      expect(await git('diff', '--cached', '--name-only')).toBe('');
    } finally {
      await cleanup();
    }
  });
  it('keeps normal commit hooks and leaves unrelated staging intact after hook rejection', async () => {
    if (process.platform === 'win32') return;
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
    try {
      const initial = await git('rev-parse', 'HEAD');
      await writeFile(path.join(repo, 'tracked.txt'), 'unrelated staged change\n');
      await checkout.stage(['tracked.txt']);
      await writeFile(path.join(repo, 'plan.md'), 'selected plan\n');
      await writeFile(
        path.join(repo, '.git/hooks/pre-commit'),
        '#!/bin/sh\necho "hook rejected" >&2\nexit 1\n',
        { mode: 0o755 }
      );
      await expect(
        checkout.commitFiles({
          paths: ['plan.md'],
          message: 'Save plan',
          expectedHead: initial,
          expectedBranch: 'refs/heads/main',
        })
      ).resolves.toMatchObject({ success: false });
      expect(await git('rev-parse', 'HEAD')).toBe(initial);
      expect(await git('diff', '--cached', '--name-only')).toBe('tracked.txt');
    } finally {
      await cleanup();
    }
  });
});

describe('explicit branch push targets', () => {
  it('reads the exact push destination without changing refs when its fetch URL points elsewhere', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
    const fork = path.join(repo, 'personal fork.git');
    const upstream = path.join(repo, 'upstream.git');
    try {
      await git('init', '--bare', fork);
      await git('init', '--bare', upstream);
      await git('remote', 'add', 'personal', upstream);
      await git('remote', 'set-url', '--push', 'personal', fork);
      const ref = localBranchRefSchema.parse('refs/heads/main');
      const target = await checkout.inspectPushTarget('personal');
      if (!target.success) throw new Error('Missing target');
      const input = {
        remote: 'personal',
        expectedRemoteFingerprint: target.data.fingerprint,
        branch: ref,
      };
      expect(await checkout.readRemoteBranch(input)).toMatchObject({
        success: true,
        data: { oid: null },
      });
      const oid = await git('rev-parse', 'HEAD');
      await git('push', fork, 'HEAD:refs/heads/main');
      expect(await checkout.readRemoteBranch(input)).toMatchObject({
        success: true,
        data: { oid },
      });
      expect(await git('rev-parse', 'HEAD')).toBe(oid);
      expect((await execFileAsync('git', ['--git-dir', upstream, 'for-each-ref'])).stdout).toBe('');
      await git('remote', 'set-url', '--push', 'personal', upstream);
      expect(await checkout.readRemoteBranch(input)).toMatchObject({ success: false });
    } finally {
      await cleanup();
    }
  });
  it('pushes only the pinned branch and commit without automatically following tags', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
    const fork = path.join(repo, 'fork.git');
    try {
      await git('init', '--bare', fork);
      await git('remote', 'add', 'personal', fork);
      await git('config', 'push.followTags', 'true');
      await git('tag', '-a', 'keep-local-tag', '-m', 'Do not push this tag');
      const oid = await git('rev-parse', 'HEAD');
      const target = await checkout.inspectPushTarget('personal');
      if (!target.success) throw new Error('Target inspection failed');
      const ref = localBranchRefSchema.parse('refs/heads/emdash/manage/test');
      const input = {
        remote: 'personal',
        expectedRemoteFingerprint: target.data.fingerprint,
        sourceRef: localBranchRefSchema.parse('refs/heads/main'),
        targetRef: ref,
        oid,
      };
      await expect(checkout.pushBranch(input)).resolves.toMatchObject({
        success: true,
        data: { oid, targetRef: ref },
      });
      expect(
        (
          await execFileAsync('git', ['--git-dir', fork, 'for-each-ref', '--format=%(refname)'])
        ).stdout.trim()
      ).toBe(ref);
      expect(
        (await execFileAsync('git', ['--git-dir', fork, 'rev-parse', ref])).stdout.trim()
      ).toBe(oid);
      await expect(checkout.pushBranch(input)).resolves.toMatchObject({ success: true });
    } finally {
      await cleanup();
    }
  });
  it('rejects retargeted remotes, multiple push destinations and stale local commits before publishing', async () => {
    const { repo, checkout, cleanup } = await makeCheckout();
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
    const first = path.join(repo, 'first.git');
    const second = path.join(repo, 'second.git');
    try {
      await git('init', '--bare', first);
      await git('init', '--bare', second);
      await git('remote', 'add', 'personal', first);
      const target = await checkout.inspectPushTarget('personal');
      if (!target.success) throw new Error('Target inspection failed');
      const input = {
        remote: 'personal',
        expectedRemoteFingerprint: target.data.fingerprint,
        sourceRef: localBranchRefSchema.parse('refs/heads/main'),
        targetRef: localBranchRefSchema.parse('refs/heads/emdash/manage/test'),
        oid: await git('rev-parse', 'HEAD'),
      };
      await git('remote', 'set-url', 'personal', second);
      await expect(checkout.pushBranch(input)).resolves.toMatchObject({
        success: false,
        error: { code: 'stale_ref_update' },
      });
      const changed = await checkout.inspectPushTarget('personal');
      if (!changed.success) throw new Error('Target inspection failed');
      await expect(
        checkout.pushBranch({
          ...input,
          expectedRemoteFingerprint: changed.data.fingerprint,
          oid: 'a'.repeat(40),
        })
      ).resolves.toMatchObject({ success: false, error: { code: 'stale_ref_update' } });
      await git('config', '--add', 'remote.personal.pushurl', first);
      await git('config', '--add', 'remote.personal.pushurl', second);
      await expect(checkout.inspectPushTarget('personal')).resolves.toMatchObject({
        success: false,
      });
      await expect(checkout.pushBranch(input)).resolves.toMatchObject({ success: false });
      for (const remote of [first, second])
        expect(
          (await execFileAsync('git', ['--git-dir', remote, 'for-each-ref'])).stdout.trim()
        ).toBe('');
    } finally {
      await cleanup();
    }
  });
  it('redacts credentials and query parameters from displayed push targets', async () => {
    const { checkout, repo, cleanup } = await makeCheckout();
    try {
      await execFileAsync(
        'git',
        [
          'remote',
          'add',
          'private',
          'https://user:example-password@example.invalid/repo.git?token=example-token',
        ],
        { cwd: repo }
      );
      const target = await checkout.inspectPushTarget('private');
      expect(target).toMatchObject({
        success: true,
        data: {
          destination: 'https://example.invalid/repo.git',
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(JSON.stringify(target)).not.toContain('example-password');
      expect(JSON.stringify(target)).not.toContain('example-token');
    } finally {
      await cleanup();
    }
  });
});

it('rejects divergent remote history without overwriting its management ref', async () => {
  const { repo, checkout, cleanup } = await makeCheckout();
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
  const fork = path.join(repo, 'fork.git');
  try {
    await git('init', '--bare', fork);
    await git('remote', 'add', 'personal', fork);
    const oid = await git('rev-parse', 'HEAD');
    const target = await checkout.inspectPushTarget('personal');
    if (!target.success) throw new Error('Target inspection failed');
    const ref = localBranchRefSchema.parse('refs/heads/emdash/manage/test');
    await git('switch', '--orphan', 'divergent');
    await writeFile(path.join(repo, 'divergent.md'), 'independent history');
    await git('add', 'divergent.md');
    await git('commit', '-m', 'Remote independent history');
    const remoteOid = await git('rev-parse', 'HEAD');
    await git('push', 'personal', `HEAD:${ref}`);
    await git('switch', 'main');
    await expect(
      checkout.pushBranch({
        remote: 'personal',
        expectedRemoteFingerprint: target.data.fingerprint,
        sourceRef: localBranchRefSchema.parse('refs/heads/main'),
        targetRef: ref,
        oid,
      })
    ).resolves.toMatchObject({ success: false, error: { type: 'rejected' } });
    expect((await execFileAsync('git', ['--git-dir', fork, 'rev-parse', ref])).stdout.trim()).toBe(
      remoteOid
    );
    expect(await git('rev-parse', 'HEAD')).toBe(oid);
  } finally {
    await cleanup();
  }
});

it('refuses generic push and publish for management branches before touching any remote', async () => {
  const { repo, checkout, cleanup } = await makeCheckout();
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
  const upstream = path.join(repo, 'upstream.git');
  try {
    await git('init', '--bare', upstream);
    await git('remote', 'add', 'origin', upstream);
    await git('switch', '-c', 'emdash/manage/test');
    await expect(checkout.push({ remote: 'origin' })).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('explicit management') },
    });
    await expect(checkout.publish('origin')).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('explicit management') },
    });
    expect(
      (await execFileAsync('git', ['--git-dir', upstream, 'for-each-ref'])).stdout.trim()
    ).toBe('');
  } finally {
    await cleanup();
  }
});
