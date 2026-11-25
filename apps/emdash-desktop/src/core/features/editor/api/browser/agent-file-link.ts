const EMDASH_FILE_LINK_ORIGIN = 'https://open-file.emdash.invalid';
const EMDASH_FILE_LINK_PATH = '/open';
const LOCATION_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

type FileLocation = { path: string; line?: number };

export function splitAgentFileLocation(target: string): FileLocation {
  const suffix = LOCATION_SUFFIX.exec(target);
  if (!suffix) return { path: target };
  const path = target.slice(0, -suffix[0].length);
  const line = Number(suffix[1] ?? suffix[2]);
  return Number.isSafeInteger(line) && line > 0 ? { path, line } : { path };
}

/** Recognize a path emitted as an OSC or Emdash short-link destination. */
export function parseAgentFilePath(target: string): FileLocation | null {
  const windowsPath = WINDOWS_ABSOLUTE_PATH.test(target);
  if (
    target !== target.trim() ||
    /[\u0000-\u001f\u007f]/u.test(target) ||
    target.startsWith('//') ||
    (!windowsPath && /^[A-Za-z][A-Za-z\d+.-]*:/u.test(target))
  ) {
    return null;
  }

  const location = splitAgentFileLocation(target);
  const { path } = location;
  return path.startsWith('/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    (/[/\\]/u.test(path) && /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/u.test(path))
    ? location
    : null;
}

/** A null result belongs to the caller's normal external-link handling. */
export function classifyEmdashFileLink(
  url: URL
): ({ kind: 'file' } & FileLocation) | { kind: 'invalid-file' } | null {
  if (url.origin !== EMDASH_FILE_LINK_ORIGIN) return null;
  const target = url.searchParams.get('path');
  if (
    url.protocol !== 'https:' ||
    url.pathname !== EMDASH_FILE_LINK_PATH ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.size !== 1 ||
    target === null ||
    target.startsWith('\\')
  ) {
    return { kind: 'invalid-file' };
  }

  const location = parseAgentFilePath(target);
  return location ? { kind: 'file', ...location } : { kind: 'invalid-file' };
}
