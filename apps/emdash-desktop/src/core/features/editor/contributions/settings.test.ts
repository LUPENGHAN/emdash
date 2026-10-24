import {
  DEFAULT_SEARCH_EXCLUDE,
  DEFAULT_TREE_EXCLUDE,
  DEFAULT_WATCHER_EXCLUDE,
} from '@emdash/core/primitives/exclusion-policy/api';
import { describe, expect, it } from 'vitest';
import { filesSettingsContribution } from './settings';

describe('filesSettingsContribution', () => {
  it('uses core exclusion defaults for tree, search, and watcher settings', () => {
    expect(filesSettingsContribution.defaults).toEqual({
      treeExclude: [...DEFAULT_TREE_EXCLUDE],
      searchExclude: [...DEFAULT_SEARCH_EXCLUDE],
      watcherExclude: [...DEFAULT_WATCHER_EXCLUDE],
      openChangedFileAsDiff: false,
    });
  });

  it('validates non-empty string pattern lists', () => {
    expect(
      filesSettingsContribution.schema.parse({
        treeExclude: ['.git'],
        searchExclude: ['node_modules'],
        watcherExclude: ['**/node_modules/**'],
      })
    ).toEqual({
      treeExclude: ['.git'],
      searchExclude: ['node_modules'],
      watcherExclude: ['**/node_modules/**'],
      openChangedFileAsDiff: false,
    });
  });

  it('keeps stored exclusion lists when the diff switch is absent', () => {
    const defaults = filesSettingsContribution.defaults;
    const base = typeof defaults === 'function' ? defaults() : defaults;
    const parsed = filesSettingsContribution.schema.safeParse({
      ...base,
      treeExclude: ['.git'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.openChangedFileAsDiff).toBe(false);
    expect(parsed.data.treeExclude).toEqual(['.git']);
    expect(parsed.data.searchExclude).toEqual([...DEFAULT_SEARCH_EXCLUDE]);
    expect(parsed.data.watcherExclude).toEqual([...DEFAULT_WATCHER_EXCLUDE]);
  });

  it('keeps a stored true value and rejects a non-boolean', () => {
    expect(
      filesSettingsContribution.schema.parse({
        treeExclude: [],
        searchExclude: [],
        watcherExclude: [],
        openChangedFileAsDiff: true,
      }).openChangedFileAsDiff
    ).toBe(true);
    expect(
      filesSettingsContribution.schema.safeParse({
        treeExclude: [],
        searchExclude: [],
        watcherExclude: [],
        openChangedFileAsDiff: 'yes',
      }).success
    ).toBe(false);
  });
});
