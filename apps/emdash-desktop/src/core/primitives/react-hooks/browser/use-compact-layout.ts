import { useSyncExternalStore } from 'react';

/** Phone-sized windows (the browser on a phone, or a very narrow window). */
const COMPACT_QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function isCompactLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches;
}

/**
 * True on phone-sized screens, where the workbench shows one full-screen view at a time
 * (the project list, a task, or a task's side panel) instead of resizable columns.
 */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompactLayout, () => false);
}
