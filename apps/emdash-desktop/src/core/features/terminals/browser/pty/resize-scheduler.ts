import { createDebounced } from '@emdash/shared/scheduling';

/**
 * Leading + trailing debounce for pane resizes.
 *
 * The flush callback is the only place a pane size change resizes the xterm
 * grid and calls `resizeBackend` together. Widths that arrive inside the quiet
 * window stay in the trailing pending value, so a drag does not reflow the
 * grid on frames where the child has not been told the new cols/rows
 * (ENG-1577: "Claude Code output overlaps input field, fixed by resizing").
 *
 * Firing on the LEADING edge keeps the SIGWINCH the child receives in lockstep
 * with the xterm grid.  The leading flush consumes the pending value, so a lone
 * resize flushes exactly once; the trailing flush still captures the final
 * value of a burst (e.g. a continuous window drag), with the burst's middle
 * coalesced.  These are exactly the leading-edge semantics of the shared
 * debounce primitive (leading only fires after a full quiet window since the
 * last flush), so this module is a thin adapter over `createDebounced`.
 */
export interface ResizeScheduler<T> {
  /** Record the latest value; flush immediately on the leading edge, else coalesce. */
  schedule: (value: T) => void;
  /** Drop any pending trailing flush (call on teardown). */
  cancel: () => void;
}

export function createResizeScheduler<T>(
  flush: (value: T) => void,
  trailingMs: number
): ResizeScheduler<T> {
  const debounced = createDebounced(flush, { delayMs: trailingMs, leading: true });
  return {
    schedule: (value: T) => debounced.call(value),
    cancel: () => debounced.cancel(),
  };
}
