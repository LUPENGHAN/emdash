import { describe, expect, it } from 'vitest';
import {
  tabDescriptorSchema,
  taskActiveFileSchema,
  taskDiffSelectionSchema,
  taskPaneLayoutMemento,
  taskPaneLayoutSchema,
} from './mementos';

describe('task pane layout memento', () => {
  it('uses a safe one-pane default', () => {
    expect(taskPaneLayoutMemento.default.groups).toHaveLength(1);
    expect(taskPaneLayoutSchema.safeParse(taskPaneLayoutMemento.default).status).toBe('ok');
  });

  it('rejects layouts without a pane', () => {
    expect(
      taskPaneLayoutSchema.safeParse({
        version: '2',
        groups: [],
        activeGroupId: '',
      }).status
    ).toBe('invalid');
  });

  it('upgrades a v1 document by dropping the abandoned paneSizes', () => {
    const result = taskPaneLayoutSchema.safeParse({
      version: '1',
      groups: [{ groupId: 'a', tabManager: { tabs: [] } }],
      activeGroupId: 'a',
      paneSizes: [100],
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data).toEqual({
        version: '2',
        groups: [{ groupId: 'a', tabManager: { tabs: [] } }],
        activeGroupId: 'a',
      });
    }
  });

  it('rejects absolute diff-tab paths', () => {
    const result = taskPaneLayoutSchema.safeParse({
      version: '2',
      groups: [
        {
          groupId: 'a',
          tabManager: {
            tabs: [
              {
                kind: 'diff',
                tabId: 'diff-1',
                path: '/repo/src/index.ts',
                diffGroup: 'disk',
                originalRef: { kind: 'commit', sha: 'HEAD' },
                isPreview: false,
              },
            ],
            activeTabId: 'diff-1',
          },
        },
      ],
      activeGroupId: 'a',
    });

    expect(result.status).toBe('invalid');
  });
});

describe('task diff selection memento', () => {
  it('preserves and validates both paths for renamed snapshots', () => {
    const file = {
      path: 'new.txt',
      originalPath: 'old.txt',
      type: 'git',
      group: 'git',
      originalRef: { kind: 'commit', sha: 'a'.repeat(40) },
    };
    expect(taskActiveFileSchema.parse(file).originalPath).toBe('old.txt');
    expect(taskActiveFileSchema.safeParse({ ...file, originalPath: '../outside' }).success).toBe(
      false
    );
    expect(
      tabDescriptorSchema.parse({
        kind: 'diff',
        tabId: 'diff',
        path: file.path,
        originalPath: file.originalPath,
        diffGroup: 'git',
        originalRef: file.originalRef,
        isPreview: false,
      })
    ).toMatchObject({ originalPath: 'old.txt' });
  });
  it('rejects absolute active diff paths', () => {
    const result = taskDiffSelectionSchema.safeParse({
      version: '1',
      activeFile: {
        path: '/repo/src/index.ts',
        type: 'disk',
        group: 'disk',
        originalRef: { kind: 'commit', sha: 'HEAD' },
      },
    });

    expect(result.status).toBe('invalid');
  });
});
