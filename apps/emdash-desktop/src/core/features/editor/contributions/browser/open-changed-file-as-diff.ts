import type { GitChange } from '@emdash/core/runtimes/git/api';
import { commitRef } from '@core/primitives/git/api';

export type ChangedFileDiffPayload = {
  activeFile: {
    path: string;
    type: 'disk' | 'git';
    group: 'disk' | 'staged';
    originalRef: ReturnType<typeof commitRef>;
  };
  status: GitChange['status'];
};

/** Diff payload matching Changes, or null when neither list has the path. */
export function diffOpenForChangedFile(
  relativePath: string,
  unstaged: readonly GitChange[],
  staged: readonly GitChange[]
): ChangedFileDiffPayload | null {
  const unstagedChange = unstaged.find((change) => change.path === relativePath);
  if (unstagedChange) {
    return {
      activeFile: {
        path: relativePath,
        type: 'disk',
        group: 'disk',
        originalRef: commitRef('HEAD'),
      },
      status: unstagedChange.status,
    };
  }
  const stagedChange = staged.find((change) => change.path === relativePath);
  if (!stagedChange) return null;
  return {
    activeFile: {
      path: relativePath,
      type: 'git',
      group: 'staged',
      originalRef: commitRef('HEAD'),
    },
    status: stagedChange.status,
  };
}

export type TreeFileOpenPlan =
  | { kind: 'file'; preview: boolean }
  | { kind: 'diff'; preview: boolean; payload: ChangedFileDiffPayload };

/**
 * Files-tree click. The setting is off while it is missing. Unstaged wins over staged.
 * `type !== 'file'` is not a branch: a symlink to a file is already an openable node.
 */
export function selectTreeFileOpen(input: {
  enabled: boolean;
  relativePath: string;
  preview: boolean;
  unstaged: readonly GitChange[];
  staged: readonly GitChange[];
}): TreeFileOpenPlan {
  if (!input.enabled) return { kind: 'file', preview: input.preview };
  const payload = diffOpenForChangedFile(input.relativePath, input.unstaged, input.staged);
  if (!payload) return { kind: 'file', preview: input.preview };
  return { kind: 'diff', preview: input.preview, payload };
}

/** A file just created in the tree opens as a file, including when Git already lists it. */
export function createdFileOpenPlan(): { kind: 'file'; preview: false } {
  return { kind: 'file', preview: false };
}
