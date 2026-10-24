import { parseFrontmatter, type CatalogSkill } from '@emdash/core/primitives/skills/api';

/** Body of an installed skill, preferring the live library copy over the opened props. */
export function installedSkillBody(
  liveSkills: readonly CatalogSkill[],
  skill: CatalogSkill
): string {
  const key = skill.installId ?? skill.id;
  const live = liveSkills.find((entry) => (entry.installId ?? entry.id) === key);
  const markdown = live?.skillMdContent ?? skill.skillMdContent ?? '';
  return parseFrontmatter(markdown).body;
}
