import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BoundExec } from '#services/exec/api';

/** Initializes a root commit without touching a checkout or replacing an existing branch. */
export async function ensureManagementBranch(
  exec: BoundExec,
  branch: string,
  workspaceId: string
): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  await exec.exec(['check-ref-format', ref]);
  const exists = async () => {
    try {
      await exec.exec(['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists()) {
    await assertManagementBranch(exec, ref, workspaceId);
    return false;
  }
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'emdash-management-tree-'));
  let tree: string;
  try {
    const file = path.join(scratch, 'empty-tree');
    await fs.writeFile(file, '', { mode: 0o600 });
    tree = (await exec.exec(['hash-object', '-w', '-t', 'tree', '--', file])).stdout.trim();
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  const root = (
    await exec.exec(
      [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        '-m',
        `Initialize Emdash management documents\n\nEmdash-Management-Workspace: ${JSON.stringify(workspaceId)}`,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: 'Emdash',
          GIT_AUTHOR_EMAIL: 'emdash@localhost',
          GIT_COMMITTER_NAME: 'Emdash',
          GIT_COMMITTER_EMAIL: 'emdash@localhost',
        },
      }
    )
  ).stdout.trim();
  try {
    await exec.exec(['update-ref', '--no-deref', ref, root, '']);
  } catch (error) {
    if (!(await exists())) throw error;
    await assertManagementBranch(exec, ref, workspaceId);
    return false;
  }
  return true;
}

export async function assertManagementBranch(
  exec: BoundExec,
  ref: string,
  workspaceId: string
): Promise<void> {
  const roots = (await exec.exec(['rev-list', '--max-parents=0', ref])).stdout.trim().split('\n');
  if (roots.length !== 1 || !roots[0])
    throw new Error('Management branch must have one independent root.');
  const message = (await exec.exec(['show', '-s', '--format=%B', roots[0]])).stdout;
  const files = (await exec.exec(['ls-tree', roots[0]])).stdout.trim();
  if (
    files ||
    !message.split('\n').includes(`Emdash-Management-Workspace: ${JSON.stringify(workspaceId)}`)
  )
    throw new Error(
      'The branch does not belong to this management workspace. Its history was preserved.'
    );
}
