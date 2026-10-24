import { describe, expect, it } from 'vitest';
import {
  bumpSkillSourceGeneration,
  currentSkillSourceGeneration,
  skillSourceCheckMayWrite,
  skillUpdateAffordance,
  skillUpdateButtonLabel,
  skillUpdateForRow,
} from './skill-update-affordance';

const source = (
  overrides: Partial<{
    updateAvailable: boolean;
    dirty: boolean;
    remoteTree: string | null;
    installedTree: string | null;
  }> = {}
) => ({
  updateAvailable: false,
  dirty: false,
  remoteTree: null as string | null,
  installedTree: null as string | null,
  ...overrides,
});

describe('skillUpdateAffordance', () => {
  it('is up to date when both trees match and nothing is dirty', () => {
    expect(
      skillUpdateAffordance(
        source({ remoteTree: 'tree-demo', installedTree: 'tree-demo', updateAvailable: false })
      )
    ).toBe('up-to-date');
    expect(skillUpdateButtonLabel('up-to-date')).toBeNull();
  });

  it('is check when the remote tree has not been read', () => {
    expect(skillUpdateAffordance(source({ remoteTree: null }))).toBe('check');
    expect(skillUpdateButtonLabel('check')).toBe('Check');
  });

  it('is update when an update is available or the folder is dirty', () => {
    expect(skillUpdateAffordance(source({ updateAvailable: true, remoteTree: null }))).toBe(
      'update'
    );
    expect(
      skillUpdateAffordance(
        source({ dirty: true, remoteTree: 'tree-demo', installedTree: 'tree-demo' })
      )
    ).toBe('update');
    expect(skillUpdateButtonLabel('update')).toBe('Update');
  });

  it('is none without a source', () => {
    expect(skillUpdateAffordance(undefined)).toBe('none');
    expect(skillUpdateButtonLabel('none')).toBeNull();
  });

  it('ignores an update result for a different skill', () => {
    expect(skillUpdateForRow('demo', { name: 'demo', remoteTree: 'tree-demo' })?.name).toBe('demo');
    expect(skillUpdateForRow('demo', { name: 'demo-2' })).toBeNull();
  });

  it('drops a check write after an update or an abort', () => {
    const started = currentSkillSourceGeneration();
    expect(skillSourceCheckMayWrite(started, { aborted: false })).toBe(true);
    expect(skillSourceCheckMayWrite(started, { aborted: true })).toBe(false);
    bumpSkillSourceGeneration();
    expect(skillSourceCheckMayWrite(started, { aborted: false })).toBe(false);
    expect(skillSourceCheckMayWrite(currentSkillSourceGeneration(), { aborted: false })).toBe(true);
  });
});
