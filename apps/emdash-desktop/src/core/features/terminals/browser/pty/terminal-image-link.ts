import {
  classifyEmdashFileLink,
  parseAgentFilePath,
} from '@core/features/editor/api/browser/agent-file-link';
import { getFileKind } from '@core/features/editor/api/browser/renderers/fileKind';

export type OscLinkTarget =
  | { kind: 'web' }
  | { kind: 'file'; path: string }
  | { kind: 'invalid-file' };

export function isImagePath(path: string): boolean {
  const kind = getFileKind(path);
  return kind === 'image' || kind === 'svg';
}

/** Classifies OSC 8 destinations without granting a terminal output access to other schemes. */
export function classifyOscLink(text: string): OscLinkTarget | null {
  const localFile = parseAgentFilePath(text);
  if (localFile) return { kind: 'file', path: localFile.path };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return /^file:/i.test(text) ? { kind: 'invalid-file' } : null;
  }
  const shortLink = classifyEmdashFileLink(url);
  if (shortLink)
    return shortLink.kind === 'file' ? { kind: 'file', path: shortLink.path } : shortLink;
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'web' };
  if (url.protocol !== 'file:') return null;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return { kind: 'invalid-file' };
  }

  // A file URL belongs to the terminal's host, not to an authority supplied by output.
  // Encoded separators are rejected rather than interpreted as path components.
  if (
    !/^file:\/\//i.test(text) ||
    url.hostname ||
    url.search ||
    url.hash ||
    text !== text.trim() ||
    /[\u0000-\u001f\u007f\\]/u.test(text) ||
    /%2f|%5c/i.test(url.pathname) ||
    /[\u0000-\u001f\u007f\\]/u.test(path) ||
    !path.startsWith('/') ||
    path.startsWith('//')
  ) {
    return { kind: 'invalid-file' };
  }

  // Keep the slash before a drive letter until the task host's path style is known.
  return { kind: 'file', path };
}
