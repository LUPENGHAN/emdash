import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ImportableSession } from '@core/primitives/conversations/api';

/**
 * Discovers agent sessions that were started outside Emdash (terminal, IDE, the
 * vendors' own apps) in a given directory, by reading each CLI's local session
 * store. Only providers whose sessions can be resumed by id are covered.
 *
 * Every reader is best-effort: stores are private CLI formats, so anything that
 * fails to parse is skipped rather than surfaced as an error.
 */

const HEAD_BYTES = 256 * 1024;
// Codex's first line (session_meta) embeds instructions and tool schemas.
const CODEX_HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const TITLE_MAX = 120;

export type ExternalSessionEnv = {
  home: string;
  env: NodeJS.ProcessEnv;
};

export type ExternalSessionReaders = {
  opencode: (env: ExternalSessionEnv, cwds: Set<string>) => ImportableSession[];
};

const defaultReaders: ExternalSessionReaders = { opencode: readOpenCodeSessions };

export async function listExternalSessions(
  cwd: string,
  options: {
    exclude?: ReadonlySet<string>;
    env?: ExternalSessionEnv;
    readers?: ExternalSessionReaders;
  } = {}
): Promise<ImportableSession[]> {
  const env = options.env ?? { home: homedir(), env: process.env };
  const readers = options.readers ?? defaultReaders;
  const cwds = await cwdVariants(cwd);

  const results = await Promise.all([
    readClaudeSessions(env, cwds).catch(() => []),
    readCodexSessions(env, cwds).catch(() => []),
    Promise.resolve()
      .then(() => readers.opencode(env, cwds))
      .catch(() => []),
  ]);
  const exclude = options.exclude ?? new Set<string>();
  return results
    .flat()
    .filter((session) => !exclude.has(session.sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The task path as given and as resolved, so symlinked roots (/tmp, /var) still match. */
async function cwdVariants(cwd: string): Promise<Set<string>> {
  const variants = new Set([path.resolve(cwd)]);
  try {
    variants.add(await realpath(cwd));
  } catch {
    // Missing directories simply match nothing.
  }
  return variants;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

/** Claude stores each project's sessions under its cwd with non-alphanumerics dashed. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function readClaudeSessions(
  { home, env }: ExternalSessionEnv,
  cwds: Set<string>
): Promise<ImportableSession[]> {
  const projectsRoot = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  const sessions: ImportableSession[] = [];
  for (const cwd of cwds) {
    const dir = path.join(projectsRoot, claudeProjectDirName(cwd));
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const session = await readClaudeSession(path.join(dir, entry), cwds).catch(() => null);
      if (session) sessions.push(session);
    }
  }
  return dedupe(sessions);
}

async function readClaudeSession(
  file: string,
  cwds: Set<string>
): Promise<ImportableSession | null> {
  const { head, tail, mtimeMs } = await readHeadAndTail(file);
  let firstMessage: string | null = null;
  let sessionCwd: string | null = null;
  for (const record of parseJsonLines(head)) {
    if (!sessionCwd && typeof record.cwd === 'string') sessionCwd = record.cwd;
    if (record.type !== 'user' || record.isSidechain || record.isMeta) continue;
    const text = claudeText(asRecord(record.message)?.content);
    if (!isNoise(text)) {
      firstMessage = text;
      break;
    }
  }
  // Directory names are lossy (a/b and a-b collide); trust the recorded cwd.
  if (!firstMessage || (sessionCwd && !cwds.has(sessionCwd))) return null;

  let customTitle: string | null = null;
  for (const record of parseJsonLines(tail)) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      customTitle = record.customTitle;
    }
  }
  return {
    providerId: 'claude',
    sessionId: path.basename(file, '.jsonl'),
    title: clip(customTitle ?? firstMessage),
    firstMessage: clip(firstMessage, 400),
    updatedAt: mtimeMs,
  };
}

function claudeText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = asRecord(block);
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('\n')
    .trim();
}

// ── Codex ────────────────────────────────────────────────────────────────────

async function readCodexSessions(
  { home, env }: ExternalSessionEnv,
  cwds: Set<string>
): Promise<ImportableSession[]> {
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
  const files = await listFilesRecursive(path.join(codexHome, 'sessions'), '.jsonl');
  const titles = await readCodexTitles(path.join(codexHome, 'session_index.jsonl'));
  const sessions: ImportableSession[] = [];
  for (const file of files) {
    const session = await readCodexSession(file, cwds, titles).catch(() => null);
    if (session) sessions.push(session);
  }
  return dedupe(sessions);
}

async function readCodexSession(
  file: string,
  cwds: Set<string>,
  titles: Map<string, string>
): Promise<ImportableSession | null> {
  const { head, mtimeMs } = await readHeadAndTail(file, 0, CODEX_HEAD_BYTES);
  let sessionId: string | null = null;
  let firstMessage: string | null = null;
  for (const record of parseJsonLines(head)) {
    const payload = asRecord(record.payload);
    if (!payload) continue;
    if (record.type === 'session_meta') {
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
      // Sub-agent threads are not resumable on their own.
      const source = payload.thread_source;
      if (!cwd || !cwds.has(cwd) || (source !== undefined && source !== 'user')) return null;
      sessionId = String(payload.id ?? payload.session_id ?? '') || null;
      continue;
    }
    const text = codexUserText(payload);
    if (text !== null && !isNoise(text)) {
      firstMessage = text;
      break;
    }
  }
  if (!sessionId) return null;
  const title = titles.get(sessionId) ?? firstMessage;
  if (!title) return null;
  return {
    providerId: 'codex',
    sessionId,
    title: clip(title),
    firstMessage: firstMessage ? clip(firstMessage, 400) : null,
    updatedAt: mtimeMs,
  };
}

function codexUserText(payload: Record<string, unknown>): string | null {
  if (payload.type === 'user_message' && typeof payload.message === 'string') {
    return payload.message.trim();
  }
  const item = asRecord(payload.item);
  if (payload.type === 'item_completed' && item?.type === 'UserMessage') {
    const content = Array.isArray(item.content) ? item.content : [];
    return content
      .map((part) => {
        const p = asRecord(part);
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('\n')
      .trim();
  }
  return null;
}

async function readCodexTitles(file: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    for (const record of parseJsonLines(await readFile(file, 'utf8'))) {
      if (typeof record.id === 'string' && typeof record.thread_name === 'string') {
        titles.set(record.id, record.thread_name);
      }
    }
  } catch {
    // No index yet.
  }
  return titles;
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

function readOpenCodeSessions(
  { home, env }: ExternalSessionEnv,
  cwds: Set<string>
): ImportableSession[] {
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  const db = new Database(path.join(dataHome, 'opencode', 'opencode.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const placeholders = [...cwds].map(() => '?').join(', ');
    // Top-level, unarchived sessions that have at least one message.
    const rows = db
      .prepare(
        `SELECT s.id, s.title, s.time_updated AS updated FROM session s
         WHERE s.directory IN (${placeholders})
           AND s.parent_id IS NULL AND s.time_archived IS NULL
           AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
         ORDER BY s.time_updated DESC LIMIT 200`
      )
      .all(...cwds) as { id: string; title: string; updated: number }[];
    // OpenCode names sessions after the fact; ones it never named keep a placeholder.
    const firstUserText = db.prepare(
      `SELECT json_extract(p.data, '$.text') AS text FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text'
       ORDER BY p.time_created LIMIT 1`
    );
    return rows.map((row) => {
      const untitled = row.title.startsWith('New session - ');
      const first = untitled
        ? ((firstUserText.get(row.id) as { text: string | null } | undefined)?.text ?? null)
        : null;
      return {
        providerId: 'opencode',
        sessionId: row.id,
        title: clip(first ?? row.title),
        firstMessage: first ? clip(first, 400) : null,
        updatedAt: row.updated,
      };
    });
  } finally {
    db.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readHeadAndTail(
  file: string,
  tailBytes = TAIL_BYTES,
  headBytes = HEAD_BYTES
): Promise<{ head: string; tail: string; mtimeMs: number }> {
  const handle = await open(file, 'r');
  try {
    const { size, mtimeMs } = await handle.stat();
    const headLength = Math.min(size, headBytes);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    let tail = '';
    if (tailBytes > 0) {
      const tailLength = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(tailLength);
      await handle.read(buffer, 0, tailLength, size - tailLength);
      tail = buffer.toString('utf8');
    }
    return { head: head.toString('utf8'), tail, mtimeMs };
  } finally {
    await handle.close();
  }
}

/** Parses complete JSON lines, skipping partial lines at buffer edges. */
function* parseJsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const value = asRecord(JSON.parse(line));
      if (value) yield value;
    } catch {
      // Truncated line at a read boundary.
    }
  }
}

async function listFilesRecursive(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true });
    const files = entries.filter((entry) => entry.endsWith(ext)).map((e) => path.join(dir, e));
    const checked = await Promise.all(
      files.map(async (file) => ((await stat(file)).isFile() ? file : null))
    );
    return checked.filter((file): file is string => file !== null);
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Slash commands, system/hook injections, caveats and Claude's compaction hand-over
 * summary are not something the user said.
 */
function isNoise(text: string): boolean {
  return (
    !text ||
    text.startsWith('<') ||
    text.startsWith('Caveat:') ||
    text.startsWith('This session is being continued from a previous conversation')
  );
}

function clip(text: string, max = TITLE_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function dedupe(sessions: ImportableSession[]): ImportableSession[] {
  const seen = new Map<string, ImportableSession>();
  for (const session of sessions) seen.set(session.sessionId, session);
  return [...seen.values()];
}
