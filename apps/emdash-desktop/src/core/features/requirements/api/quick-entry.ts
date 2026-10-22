import { REQUIREMENT_TITLE_MAX } from './types';

/**
 * A quick entry's first line is the title and the rest its detail. A title over the
 * limit is cut there, and what was cut leads the detail rather than being lost.
 */
export function splitQuickEntry(text: string): { title: string; detail?: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const newline = trimmed.indexOf('\n');
  const firstLine = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
  const rest = newline === -1 ? '' : trimmed.slice(newline + 1).trim();
  const title = firstLine.slice(0, REQUIREMENT_TITLE_MAX).trim();
  const overflow = firstLine.slice(REQUIREMENT_TITLE_MAX).trim();
  const detail = [overflow, rest].filter(Boolean).join('\n');
  return detail ? { title, detail } : { title };
}
