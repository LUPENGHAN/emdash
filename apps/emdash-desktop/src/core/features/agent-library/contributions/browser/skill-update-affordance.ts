import type { SkillSourceView } from '../../api';

export type SkillUpdateAffordance = 'check' | 'update' | 'up-to-date' | 'none';

/** Which control a skill row shows. Check and Update call different requests. */
export function skillUpdateAffordance(
  source:
    | Pick<SkillSourceView, 'updateAvailable' | 'dirty' | 'remoteTree' | 'installedTree'>
    | undefined
): SkillUpdateAffordance {
  if (!source) return 'none';
  if (source.updateAvailable || source.dirty) return 'update';
  if (source.remoteTree && source.remoteTree === source.installedTree) return 'up-to-date';
  if (source.remoteTree === null) return 'check';
  return 'update';
}

/** Button label for an affordance. Up to date and no source have no button. */
export function skillUpdateButtonLabel(
  affordance: SkillUpdateAffordance
): 'Check' | 'Update' | null {
  if (affordance === 'check') return 'Check';
  if (affordance === 'update') return 'Update';
  return null;
}

/** The returned source, when it is this row. A different name is not written. */
export function skillUpdateForRow<T extends { name: string }>(
  rowName: string,
  source: T
): T | null {
  return source.name === rowName ? source : null;
}

let skillSourceGeneration = 0;

export function currentSkillSourceGeneration(): number {
  return skillSourceGeneration;
}

/** An update finished; checks that started earlier must not write their snapshot. */
export function bumpSkillSourceGeneration(): void {
  skillSourceGeneration += 1;
}

export function skillSourceCheckMayWrite(started: number, signal: { aborted: boolean }): boolean {
  return !signal.aborted && started === skillSourceGeneration;
}
