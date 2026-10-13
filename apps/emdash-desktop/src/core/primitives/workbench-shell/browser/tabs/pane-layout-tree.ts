import type { SplitSide } from './pane-drop-target';
import type { PaneLayoutNode } from './persistence';

export type { PaneLayoutNode };
export type PaneSplitOrientation = 'horizontal' | 'vertical';

export function orientationFor(side: SplitSide): PaneSplitOrientation {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
}

/** One horizontal row. A single pane stays a leaf so it does not invent a split id. */
export function horizontalLayout(paneIds: readonly string[], splitId = 'root'): PaneLayoutNode {
  if (paneIds.length === 1) return { kind: 'pane', paneId: paneIds[0] ?? '' };
  return {
    kind: 'split',
    id: splitId,
    orientation: 'horizontal',
    children: paneIds.map((paneId) => ({ kind: 'pane', paneId })),
  };
}

export function layoutPaneIds(node: PaneLayoutNode): string[] {
  if (node.kind === 'pane') return [node.paneId];
  return node.children.flatMap(layoutPaneIds);
}

export function insertPaneInLayout(
  root: PaneLayoutNode,
  targetPaneId: string,
  side: SplitSide,
  newPaneId: string,
  splitId: string
): PaneLayoutNode {
  const orientation = orientationFor(side);
  const after = side === 'right' || side === 'bottom';
  const created: PaneLayoutNode = { kind: 'pane', paneId: newPaneId };

  function visit(node: PaneLayoutNode): PaneLayoutNode {
    if (node.kind === 'pane') {
      if (node.paneId !== targetPaneId) return node;
      const children = after ? [node, created] : [created, node];
      return { kind: 'split', id: splitId, orientation, children };
    }

    const directIndex = node.children.findIndex(
      (child) => child.kind === 'pane' && child.paneId === targetPaneId
    );
    if (directIndex !== -1 && node.orientation === orientation) {
      const children = node.children.slice();
      children.splice(after ? directIndex + 1 : directIndex, 0, created);
      return { ...node, children };
    }

    let changed = false;
    const children = node.children.map((child) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, children } : node;
  }

  return visit(root);
}

export function removePaneFromLayout(root: PaneLayoutNode, paneId: string): PaneLayoutNode {
  function visit(node: PaneLayoutNode): PaneLayoutNode | null {
    if (node.kind === 'pane') return node.paneId === paneId ? null : node;
    const children = node.children
      .map(visit)
      .filter((child): child is PaneLayoutNode => child !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0] ?? null;
    return { ...node, children: flattenSameOrientation(node.orientation, children) };
  }
  return visit(root) ?? root;
}

/**
 * Drops empty splits, collapses single-child splits, and splices a child split
 * into a parent of the same orientation. Returns null when no pane remains.
 */
export function normalizeLayout(node: PaneLayoutNode): PaneLayoutNode | null {
  if (node.kind === 'pane') return node;
  const children = node.children
    .map(normalizeLayout)
    .filter((child): child is PaneLayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { ...node, children: flattenSameOrientation(node.orientation, children) };
}

function flattenSameOrientation(
  orientation: PaneSplitOrientation,
  children: PaneLayoutNode[]
): PaneLayoutNode[] {
  return children.flatMap((child) =>
    child.kind === 'split' && child.orientation === orientation ? child.children : [child]
  );
}

export function layoutSplitIds(node: PaneLayoutNode): string[] {
  if (node.kind === 'pane') return [];
  return [node.id, ...node.children.flatMap(layoutSplitIds)];
}

/** The pane that should take focus after `paneId` closes, if one remains beside it. */
export function neighborPaneId(root: PaneLayoutNode, paneId: string): string | undefined {
  const parent = findParent(root, paneId);
  if (!parent) return layoutPaneIds(root).find((id) => id !== paneId);
  const index = parent.children.findIndex(
    (child) => child.kind === 'pane' && child.paneId === paneId
  );
  const sibling = parent.children[index + 1] ?? parent.children[index - 1];
  if (!sibling) return layoutPaneIds(root).find((id) => id !== paneId);
  return layoutPaneIds(sibling)[0];
}

/**
 * Dropping the only tab of `sourcePaneId` onto an edge that already borders it
 * does not change the layout. Dropping onto the pane's own edge is the same.
 */
export function splitWouldDuplicateSinglePane(
  root: PaneLayoutNode,
  sourcePaneId: string,
  targetPaneId: string,
  side: SplitSide
): boolean {
  if (sourcePaneId === targetPaneId) return true;
  const parent = findParent(root, targetPaneId);
  if (!parent || parent.orientation !== orientationFor(side)) return false;
  const index = parent.children.findIndex(
    (child) => child.kind === 'pane' && child.paneId === targetPaneId
  );
  const neighborIndex = side === 'right' || side === 'bottom' ? index + 1 : index - 1;
  const neighbor = parent.children[neighborIndex];
  if (!neighbor) return false;
  return layoutPaneIds(neighbor).includes(sourcePaneId) && neighbor.kind === 'pane';
}

/**
 * The pane directly beside `paneId` toward `side`: the nearest ancestor split of
 * that orientation with a sibling on that side, then the pane on the sibling's
 * facing edge.
 */
export function adjacentPaneId(
  root: PaneLayoutNode,
  paneId: string,
  side: SplitSide
): string | undefined {
  const orientation = orientationFor(side);
  const forward = side === 'right' || side === 'bottom';
  const path = pathToPane(root, paneId);
  if (!path) return undefined;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const step = path[depth];
    if (!step || step.split.orientation !== orientation) continue;
    const neighbor = step.split.children[forward ? step.index + 1 : step.index - 1];
    if (neighbor) return facingEdgePaneId(neighbor, orientation, forward);
  }
  return undefined;
}

function facingEdgePaneId(
  node: PaneLayoutNode,
  orientation: PaneSplitOrientation,
  forward: boolean
): string | undefined {
  if (node.kind === 'pane') return node.paneId;
  const children = node.children;
  const child =
    node.orientation === orientation && !forward ? children[children.length - 1] : children[0];
  return child ? facingEdgePaneId(child, orientation, forward) : undefined;
}

type SplitNode = Extract<PaneLayoutNode, { kind: 'split' }>;

function pathToPane(
  node: PaneLayoutNode,
  paneId: string
): Array<{ split: SplitNode; index: number }> | null {
  if (node.kind === 'pane') return node.paneId === paneId ? [] : null;
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    const rest = child ? pathToPane(child, paneId) : null;
    if (rest) return [{ split: node, index }, ...rest];
  }
  return null;
}

function findParent(
  root: PaneLayoutNode,
  paneId: string
): Extract<PaneLayoutNode, { kind: 'split' }> | null {
  if (root.kind === 'pane') return null;
  for (const child of root.children) {
    if (child.kind === 'pane' && child.paneId === paneId) return root;
    const nested = findParent(child, paneId);
    if (nested) return nested;
  }
  return null;
}
