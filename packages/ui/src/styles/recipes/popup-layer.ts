/**
 * Electron treats `-webkit-app-region: drag` as a native hit target that ignores
 * z-index. A popup painted over the borderless titlebar, or over a sticky header
 * that is itself a drag region, never receives the click. Provider and model
 * lists are tall enough to reach that strip, so the rows at the top cannot be
 * chosen until the popup opts out.
 */
export const noDragRegion = { WebkitAppRegion: 'no-drag' } as Record<string, string>;

/**
 * Keep a floating popup below the h-10 window drag strip, with the usual inset
 * on the other edges. The default 5px padding lets a tall list sit under the
 * titlebar.
 */
export const popupCollisionPadding = { top: 48, right: 8, bottom: 8, left: 8 };
