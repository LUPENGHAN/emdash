import type { Requirement } from './types';

/** Select value for a requirement that has no parent. Not a requirement id. */
export const REQUIREMENT_TOP_LEVEL = 'top-level';

export function indexRequirements(items: Requirement[]): Map<string, Requirement> {
  return new Map(items.map((item) => [item.id, item]));
}

/** The top-level parent this item is stored under, when that parent is in the list. */
export function topLevelParent(
  item: Requirement,
  byId: Map<string, Requirement>
): Requirement | null {
  if (!item.parentId) return null;
  const parent = byId.get(item.parentId);
  if (!parent || parent.parentId) return null;
  return parent;
}

export function isTopLevel(item: Requirement, byId: Map<string, Requirement>): boolean {
  return topLevelParent(item, byId) === null;
}

/** Direct sub-requirements, oldest first. */
export function directChildren(parentId: string, items: Requirement[]): Requirement[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export type RequirementRow = {
  item: Requirement;
  depth: 0 | 1;
};

/**
 * Sidebar rows for one status filter.
 * Open keeps a done parent when it still has an open sub-requirement, after the open
 * top-level rows. Done shows an open parent as a group header when a sub-requirement
 * is done; that header is a row here and is not part of the done count.
 */
export function visibleRequirementRows(
  items: Requirement[],
  filter: Requirement['status']
): RequirementRow[] {
  const byId = indexRequirements(items);
  const tops = items.filter((item) => isTopLevel(item, byId));
  const visible = tops.filter((item) => {
    const children = directChildren(item.id, items);
    if (item.status === filter) return true;
    return children.some((child) => child.status === filter);
  });
  visible.sort(
    (left, right) =>
      Number(left.status !== filter) - Number(right.status !== filter) ||
      right.createdAt - left.createdAt
  );

  const rows: RequirementRow[] = [];
  for (const item of visible) {
    rows.push({ item, depth: 0 });
    for (const child of directChildren(item.id, items)) {
      if (child.status === filter) rows.push({ item: child, depth: 1 });
    }
  }
  return rows;
}

/** Unfinished/total for a parent row. Null when it has no sub-requirements. */
export function childProgress(
  item: Requirement,
  items: Requirement[]
): { open: number; total: number } | null {
  const children = directChildren(item.id, items);
  if (children.length === 0) return null;
  return {
    open: children.filter((child) => child.status === 'open').length,
    total: children.length,
  };
}

/** Other real top-level requirements this item could be moved under. */
export function parentChoices(item: Requirement, items: Requirement[]): Requirement[] {
  if (directChildren(item.id, items).length > 0) return [];
  return items.filter((other) => other.id !== item.id && !other.parentId);
}

export function canChangeParent(item: Requirement, items: Requirement[]): boolean {
  if (directChildren(item.id, items).length > 0) return false;
  return Boolean(item.parentId) || parentChoices(item, items).length > 0;
}

/** Title, detail, then the titles of unfinished sub-requirements. */
export function requirementTaskPrompt(item: Requirement, items: Requirement[]): string {
  const body = item.detail ? `${item.title}\n\n${item.detail}` : item.title;
  const titles = directChildren(item.id, items)
    .filter((child) => child.status === 'open')
    .map((child) => child.title);
  if (titles.length === 0) return body;
  return `${body}\n\n${titles.map((title) => `- ${title}`).join('\n')}`;
}
