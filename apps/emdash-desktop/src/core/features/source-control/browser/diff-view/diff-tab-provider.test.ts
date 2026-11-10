import { describe, expect, it } from 'vitest';
import { portablePath } from '@core/primitives/desktop-runtime/api';
import { commitRef } from '@core/primitives/git/api';
import { diffTabProvider } from './diff-tab-provider';

describe('diff tab identity', () => {
  it('keeps new diff tabs checkout-relative', () => {
    const payload = diffTabProvider.onBeforeOpen!(
      {
        activeFile: {
          path: portablePath('src/index.ts'),
          type: 'disk',
          group: 'disk',
          originalRef: commitRef('HEAD'),
        },
      },
      { viewId: 'task-1' }
    );

    expect(payload).toMatchObject({ path: 'src/index.ts', diffGroup: 'disk' });
  });

  it('keeps snapshots with different paths or refs in distinct tabs', () => {
    const state = {
      path: portablePath('new.txt'),
      originalPath: portablePath('old.txt'),
      diffGroup: 'git' as const,
      originalRef: commitRef('a'.repeat(40)),
      modifiedRef: commitRef('b'.repeat(40)),
    };
    expect(diffTabProvider.resourceKey(state)).not.toBe(
      diffTabProvider.resourceKey({ ...state, originalPath: portablePath('other.txt') })
    );
    expect(diffTabProvider.resourceKey(state)).not.toBe(
      diffTabProvider.resourceKey({ ...state, modifiedRef: commitRef('c'.repeat(40)) })
    );
    const payload = diffTabProvider.onBeforeOpen!(
      {
        activeFile: {
          path: state.path,
          originalPath: state.originalPath,
          type: 'git',
          group: 'git',
          originalRef: state.originalRef,
          modifiedRef: state.modifiedRef,
        },
      },
      { viewId: 'task-1' }
    );
    expect(payload).toMatchObject({ path: 'new.txt', originalPath: 'old.txt' });
  });
});
