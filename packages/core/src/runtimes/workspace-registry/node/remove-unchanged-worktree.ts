import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { RemoveUnchangedWorktreeError } from '../api/errors';
import type { RemoveUnchangedWorktreeInput } from '../api/schemas/operations';
import type { RegistryGitContext } from './git-context';
import { validateWorktreePath } from './worktree-path-safety';

export function cleanupRefusal(
  reason: RemoveUnchangedWorktreeError['reason'],
  message: string
): Result<never, RemoveUnchangedWorktreeError> {
  return err({ type: 'cleanup-refused', reason, message });
}

export async function worktreePathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The caller holds its workspace claim; guards and removal share the checkout writer lock. */
export async function removeUnchangedWorktree(
  input: RemoveUnchangedWorktreeInput,
  git: RegistryGitContext,
  isActive: () => Promise<boolean>
): Promise<Result<void, RemoveUnchangedWorktreeError>> {
  return git.locks.withWriter(input.path, async () => {
    try {
      if (await isActive())
        return cleanupRefusal('workspace-active', 'The verification workspace is still active.');
      const options = { timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 };
      const repository = git.exec(input.repositoryPath, {
        tier: 'activation',
        repository: input.repositoryPath,
      });
      if (!(await worktreePathExists(input.path))) {
        const listed = await repository.exec(['worktree', 'list', '--porcelain', '-z'], options);
        const entry = listed.stdout
          .split('\0\0')
          .map((record) => record.split('\0'))
          .find((fields) => fields.some((field) => field === `worktree ${input.path}`));
        if (!entry) return ok(undefined);
        if (
          !entry.includes(`HEAD ${input.oid}`) ||
          !entry.includes(`branch refs/heads/${input.branch}`)
        )
          return cleanupRefusal(
            'identity-changed',
            'The missing checkout has different Git registration.'
          );
        if (entry.some((field) => field === 'locked' || field.startsWith('locked ')))
          return cleanupRefusal('workspace-active', 'The missing checkout is locked.');
        await repository.exec(['worktree', 'remove', '--', input.path], options);
        return ok(undefined);
      }
      if ((await lstat(input.path)).isSymbolicLink())
        return cleanupRefusal('unsafe-path', 'The verification path is a symbolic link.');
      const safe = await validateWorktreePath({
        repoPath: input.repositoryPath,
        targetPath: input.path,
        mutation: 'remove',
        createGitExec: (cwd) => git.exec(cwd),
      });
      if (!safe.success) return cleanupRefusal('unsafe-path', safe.error.message);
      const exec = git.exec(input.path, { tier: 'activation', repository: input.repositoryPath });
      const head = (await exec.exec(['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
      const branch = (await exec.exec(['symbolic-ref', '--quiet', 'HEAD'], options)).stdout.trim();
      const top = (await exec.exec(['rev-parse', '--show-toplevel'], options)).stdout.replace(
        /\r?\n$/,
        ''
      );
      if (
        head !== input.oid ||
        branch !== `refs/heads/${input.branch}` ||
        (await realpath(top)) !== (await realpath(input.path))
      )
        return cleanupRefusal('identity-changed', 'The verification checkout identity changed.');
      const admin = (await exec.exec(['rev-parse', '--absolute-git-dir'], options)).stdout.replace(
        /\r?\n$/,
        ''
      );
      for (const marker of [
        'index.lock',
        'HEAD.lock',
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-apply',
        'rebase-merge',
        'sequencer',
        'locked',
      ]) {
        if (await worktreePathExists(path.join(admin, marker)))
          return cleanupRefusal(
            'workspace-active',
            'The verification checkout has a Git operation or lock.'
          );
      }
      // Index flags can hide edits from status and from Git's own non-force removal guard.
      const index = (await exec.exec(['ls-files', '-v', '-z'], options)).stdout;
      if (index.split('\0').some((entry) => /^[a-zS]/.test(entry)))
        return cleanupRefusal(
          'worktree-dirty',
          'Index flags prevent proving the checkout is unchanged.'
        );
      const status = await exec.exec(
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignored=matching',
          '--ignore-submodules=none',
        ],
        options
      );
      if (status.stdout.length > 0)
        return cleanupRefusal(
          'worktree-dirty',
          'The verification checkout contains changes, untracked files, or ignored files.'
        );
      if (await isActive())
        return cleanupRefusal('workspace-active', 'The verification workspace became active.');
      try {
        // No force, prune, branch deletion, lifecycle scripts, or recursive filesystem removal.
        await repository.exec(['worktree', 'remove', '--', input.path], options);
      } catch (error) {
        return cleanupRefusal(
          'removal-failed',
          error instanceof Error ? error.message : String(error)
        );
      }
      return ok(undefined);
    } catch (error) {
      return cleanupRefusal(
        'inspection-failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}
