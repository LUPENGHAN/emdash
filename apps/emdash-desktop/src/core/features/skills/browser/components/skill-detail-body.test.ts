import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import { describe, expect, it } from 'vitest';
import { installedSkillBody } from './skill-detail-body';

function skill(patch: Partial<CatalogSkill>): CatalogSkill {
  return {
    id: 'review-pr',
    displayName: 'review-pr',
    description: 'The catalog still says the old sentence',
    source: 'local',
    frontmatter: { name: 'review-pr', description: '' },
    installed: true,
    ...patch,
  };
}

const markdown = (body: string) => `---\nname: review-pr\n---\n${body}`;

describe('installedSkillBody', () => {
  it('returns the live body for the same install id', () => {
    const opened = skill({
      id: 'catalog-id',
      installId: 'review-pr',
      skillMdContent: markdown('old'),
    });
    const live = skill({
      id: 'other',
      installId: 'review-pr',
      skillMdContent: markdown('new'),
    });
    const wrongId = skill({
      id: 'catalog-id',
      installId: 'someone-else',
      skillMdContent: markdown('catalog'),
    });

    expect(installedSkillBody([wrongId, live], opened)).toBe('new');
    expect(installedSkillBody([wrongId, live], opened)).not.toContain('old');
    expect(installedSkillBody([wrongId, live], opened)).not.toBe(opened.description);
  });

  it('uses the opened body until the live entry arrives', () => {
    const opened = skill({ skillMdContent: markdown('old') });
    expect(installedSkillBody([], opened)).toBe('old');
  });
});
