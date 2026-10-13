import { useDndContext, useDroppable } from '@dnd-kit/core';
import { cn } from '@core/primitives/styling/browser/cn';
import { paneDropTargetId, type SplitSide } from '../pane-drop-target';
import { usePaneLayoutContext } from '../pane-layout-context';

/**
 * Edge drop zones that create a new split pane on drop (VS Code style).
 * Mounted only while a drag is active, so the strips never intercept normal
 * pointer interaction with the pane content. Hit area is the outer 20% of the
 * content region; the hover highlight previews the half where the new pane
 * lands. PaneLayoutStore owns drop validity, so invalid zones are not mounted.
 */
export function PaneSplitDropZones({ paneId }: { paneId: string }) {
  const { active } = useDndContext();
  if (!active) return null;
  return (
    <>
      <SplitZone paneId={paneId} side="left" draggedId={String(active.id)} />
      <SplitZone paneId={paneId} side="right" draggedId={String(active.id)} />
      <SplitZone paneId={paneId} side="top" draggedId={String(active.id)} />
      <SplitZone paneId={paneId} side="bottom" draggedId={String(active.id)} />
    </>
  );
}

function SplitZone({
  paneId,
  side,
  draggedId,
}: {
  paneId: string;
  side: SplitSide;
  draggedId: string;
}) {
  const paneLayout = usePaneLayoutContext();
  const canSplit = paneLayout.canSplitAt(paneId, side, draggedId);
  const { setNodeRef, isOver } = useDroppable({
    id: paneDropTargetId({ kind: 'split', paneId, side }),
    disabled: !canSplit,
  });
  if (!canSplit) return null;
  const horizontal = side === 'left' || side === 'right';
  return (
    <>
      <div
        ref={setNodeRef}
        className={cn(
          'absolute z-30',
          horizontal ? 'inset-y-0 w-1/5' : 'inset-x-0 h-1/5',
          side === 'left' && 'left-0',
          side === 'right' && 'right-0',
          side === 'top' && 'top-0',
          side === 'bottom' && 'bottom-0'
        )}
      />
      {isOver && (
        <div
          className={cn(
            'pointer-events-none absolute z-20 bg-foreground/10',
            horizontal ? 'inset-y-0 w-1/2' : 'inset-x-0 h-1/2',
            side === 'left' && 'left-0',
            side === 'right' && 'right-0',
            side === 'top' && 'top-0',
            side === 'bottom' && 'bottom-0'
          )}
        />
      )}
    </>
  );
}
