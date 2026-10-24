import type { GitChange, GitChangeStatus } from '@emdash/core/runtimes/git/api';
import { describe, expect, it } from 'vitest';
import { commitRef } from '@core/primitives/git/api';
import {
  createdFileOpenPlan,
  diffOpenForChangedFile,
  selectTreeFileOpen,
} from './open-changed-file-as-diff';

const change = (path: string, status: GitChangeStatus = 'modified'): GitChange => ({
  path,
  status,
  additions: 1,
  deletions: 0,
});

const head = commitRef('HEAD');

describe('selectTreeFileOpen', () => {
  it('opens a file tab when the setting is off or still loading', () => {
    const unstaged = [change('src/app.ts')];
    expect(
      selectTreeFileOpen({
        enabled: false,
        relativePath: 'src/app.ts',
        preview: true,
        unstaged,
        staged: [],
      })
    ).toEqual({ kind: 'file', preview: true });
  });

  it('opens an unstaged disk diff ahead of a staged change', () => {
    const plan = selectTreeFileOpen({
      enabled: true,
      relativePath: 'src/app.ts',
      preview: true,
      unstaged: [change('src/app.ts', 'modified')],
      staged: [change('src/app.ts', 'added')],
    });
    expect(plan).toEqual({
      kind: 'diff',
      preview: true,
      payload: {
        activeFile: { path: 'src/app.ts', type: 'disk', group: 'disk', originalRef: head },
        status: 'modified',
      },
    });
  });

  it('opens a staged diff only when the path is not unstaged', () => {
    expect(
      selectTreeFileOpen({
        enabled: true,
        relativePath: 'lib/app.ts',
        preview: false,
        unstaged: [change('src/app.ts')],
        staged: [change('lib/app.ts', 'added')],
      })
    ).toEqual({
      kind: 'diff',
      preview: false,
      payload: {
        activeFile: { path: 'lib/app.ts', type: 'git', group: 'staged', originalRef: head },
        status: 'added',
      },
    });
  });

  it('opens a file tab when the path is gone from both lists', () => {
    expect(diffOpenForChangedFile('src/app.ts', [], [])).toBeNull();
    expect(
      selectTreeFileOpen({
        enabled: true,
        relativePath: 'src/app.ts',
        preview: true,
        unstaged: [],
        staged: [],
      })
    ).toEqual({ kind: 'file', preview: true });
  });

  it('opens a deleted unstaged path as a disk diff', () => {
    expect(diffOpenForChangedFile('src/app.ts', [change('src/app.ts', 'deleted')], [])).toEqual({
      activeFile: { path: 'src/app.ts', type: 'disk', group: 'disk', originalRef: head },
      status: 'deleted',
    });
  });

  it('uses the preview from the latest click and does not reuse a cleared list', () => {
    const unstaged = [change('src/app.ts')];
    expect(
      selectTreeFileOpen({
        enabled: true,
        relativePath: 'src/app.ts',
        preview: true,
        unstaged,
        staged: [],
      }).kind
    ).toBe('diff');
    expect(
      selectTreeFileOpen({
        enabled: true,
        relativePath: 'src/app.ts',
        preview: true,
        unstaged,
        staged: [],
      }).kind
    ).toBe('diff');
    expect(
      selectTreeFileOpen({
        enabled: true,
        relativePath: 'src/app.ts',
        preview: false,
        unstaged: [],
        staged: [],
      })
    ).toEqual({ kind: 'file', preview: false });
  });

  it('opens a created file as a file even when that path is unstaged', () => {
    expect(createdFileOpenPlan()).toEqual({ kind: 'file', preview: false });
    expect(
      diffOpenForChangedFile('src/new.ts', [change('src/new.ts', 'added')], [])
    ).not.toBeNull();
  });
});
