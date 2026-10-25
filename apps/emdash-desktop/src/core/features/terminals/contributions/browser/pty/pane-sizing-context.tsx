/**
 * PaneSizingContext — PTY sizing bridge for a pane.
 *
 * Reads the nearest PaneDimensionProvider (mounted by SplitPane) and drives a
 * single per-pane resize controller shared across all terminals in the pane.
 * Consumed by use-pty.ts via usePaneSizingContext().
 *
 * The controller (usePtyPaneResize) owns:
 *   - Converting pane pixel dimensions → cols/rows
 *   - Broadcasting runtime resize calls to ALL sessions (active + background)
 *   - Exposing controllerDims as the last flushed cols/rows for pre-mount sizing
 */

import type { IObservableValue } from 'mobx';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePtyPaneResize } from '@core/features/terminals/browser/pty/use-pty-pane-resize';
import type { PaneDimensionSink } from '@core/primitives/workbench-shell/browser/tabs/pane-dimension-provider';
import { usePaneDimensions } from '@core/primitives/workbench-shell/browser/tabs/pane-dimension-provider';

// ── Context interface ─────────────────────────────────────────────────────────

export interface PaneSizingContextValue {
  /**
   * Last cols/rows written by a scheduler flush. Null until that first flush.
   */
  controllerDims: IObservableValue<{ cols: number; rows: number } | null>;
  /**
   * Called by a mounted terminal with its exact CSS cell dimensions.
   * Refines the controller's cell size for accurate cols/rows computation.
   */
  calibrateCell(width: number, height: number): void;
  /** Last flushed cols/rows, for pre-mount sizing. Null before the first flush. */
  getCurrentDimensions(): { cols: number; rows: number } | null;
  /** Ref to the pane container element (used for pre-mount dimension fallback). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The pane's observable pixel dimension sink. */
  sink: PaneDimensionSink;
  /**
   * Extra bottom inset (px) subtracted from the available height before the
   * grid calculation. Used to account for chrome rendered inside the measured
   * content region (e.g. the conversations ContextBar). Defaults to 0.
   */
  bottomPadding: number;
}

const PaneSizingContext = createContext<PaneSizingContextValue | null>(null);

export function usePaneSizingContext(): PaneSizingContextValue | null {
  return useContext(PaneSizingContext);
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function PaneSizingContextProvider({
  sessionIds,
  bottomPadding = 0,
  children,
}: {
  sessionIds: string[];
  /**
   * Extra bottom inset (px) subtracted from the measured content height before
   * the grid calculation. Use this to account for chrome that sits inside the
   * measured region but below the terminal (e.g. the conversations ContextBar).
   */
  bottomPadding?: number;
  children: ReactNode;
}) {
  const dims = usePaneDimensions();
  const sink = dims?.sink ?? null;

  const { controllerDims, calibrateCell, getCurrentDimensions } = usePtyPaneResize(
    sessionIds,
    sink,
    bottomPadding
  );

  const value = useMemo<PaneSizingContextValue | null>(() => {
    if (!dims) return null;
    return {
      controllerDims,
      calibrateCell,
      getCurrentDimensions,
      containerRef: dims.containerRef,
      sink: dims.sink,
      bottomPadding,
    };
  }, [dims, controllerDims, calibrateCell, getCurrentDimensions, bottomPadding]);

  return <PaneSizingContext.Provider value={value}>{children}</PaneSizingContext.Provider>;
}
