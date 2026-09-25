import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ImportableSession } from '@core/primitives/conversations/api';
import type { ExternalSessionEnv } from './external-sessions';

/**
 * Cursor's CLI keeps terminal sessions under `chats/<hash>/<id>/` and chat (ACP) sessions
 * under `acp-sessions/<id>/`; each has a meta.json (cwd, title) and a store.db whose
 * `blobs` are the messages, ordered by the root blob named in `meta`.
 */
export function cursorHome({ home, env }: ExternalSessionEnv): string {
  return env.CURSOR_CONFIG_DIR ?? path.join(home, '.cursor');
}

type CursorMeta = { cwd?: unknown; title?: unknown; hasConversation?: unknown };

export async function readCursorSessions(
  env: ExternalSessionEnv,
  cwds: Set<string>,
  clip: (text: string) => string
): Promise<ImportableSession[]> {
  const root = cursorHome(env);
  const sessions: ImportableSession[] = [];

  // Chat UI sessions: acp-sessions/<id>/.
  for (const id of await listDirs(path.join(root, 'acp-sessions'))) {
    const dir = path.join(root, 'acp-sessions', id);
    const session = await readCursorSessionDir(dir, id, 'acp', cwds, clip);
    if (session) sessions.push(session);
  }
  // Terminal sessions: chats/<cwd hash>/<id>/.
  for (const bucket of await listDirs(path.join(root, 'chats'))) {
    for (const id of await listDirs(path.join(root, 'chats', bucket))) {
      const dir = path.join(root, 'chats', bucket, id);
      const session = await readCursorSessionDir(dir, id, 'pty', cwds, clip);
      if (session) sessions.push(session);
    }
  }
  return sessions;
}

async function readCursorSessionDir(
  dir: string,
  id: string,
  resumeIn: 'pty' | 'acp',
  cwds: Set<string>,
  clip: (text: string) => string
): Promise<ImportableSession | null> {
  try {
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as CursorMeta;
    if (typeof meta.cwd !== 'string' || !cwds.has(meta.cwd)) return null;
    if (meta.hasConversation === false) return null;
    const store = path.join(dir, 'store.db');
    const updatedAt = await latestMtime([store, `${store}-wal`, path.join(dir, 'meta.json')]);
    const turns = readCursorTurns(store);
    const firstMessage = turns.find((turn) => turn.role === 'user')?.text ?? null;
    if (!firstMessage) return null; // Nothing was said in it.
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : firstMessage;
    return {
      providerId: 'cursor',
      sessionId: id,
      title: clip(title),
      firstMessage: clip(firstMessage),
      updatedAt,
      cwd: meta.cwd,
      resumeIn,
    };
  } catch {
    return null;
  }
}

export type CursorTurn = { role: 'user' | 'assistant'; text: string };

/** The spoken turns of a Cursor session store, in order. Empty when unreadable. */
export function readCursorTurns(storePath: string): CursorTurn[] {
  let db: Database.Database;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const metaRow = db.prepare(`SELECT value FROM meta WHERE key = '0'`).get() as
      | { value: string }
      | undefined;
    if (!metaRow) return [];
    const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8')) as {
      latestRootBlobId?: string;
    };
    if (!meta.latestRootBlobId) return [];
    const blob = db.prepare('SELECT data FROM blobs WHERE id = ?');
    const root = blob.get(meta.latestRootBlobId) as { data: Buffer } | undefined;
    if (!root) return [];

    const turns: CursorTurn[] = [];
    for (const messageId of rootMessageIds(root.data)) {
      const row = blob.get(messageId) as { data: Buffer } | undefined;
      if (!row) continue;
      const turn = parseCursorMessage(row.data);
      if (turn) turns.push(turn);
    }
    return turns;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Root blob: protobuf whose field 1 repeats the 32-byte ids of the message blobs. */
export function rootMessageIds(data: Buffer): string[] {
  const ids: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const tag = data[offset++]!;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      let length = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = data[offset++]!;
        length |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      if (tag >> 3 === 1 && length === 32) {
        ids.push(data.subarray(offset, offset + 32).toString('hex'));
      }
      offset += length;
    } else if (wireType === 0) {
      while (data[offset++]! & 0x80);
    } else {
      break; // Unknown layout: stop rather than misread.
    }
  }
  return ids;
}

export function parseCursorMessage(data: Buffer): CursorTurn | null {
  let message: { role?: unknown; content?: unknown };
  try {
    message = JSON.parse(data.toString('utf8')) as typeof message;
  } catch {
    return null;
  }
  const text = contentText(message.content).trim();
  if (!text) return null;
  if (message.role === 'user') {
    // User turns wrap the actual ask in injected context; keep just the ask.
    const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1]?.trim();
    if (query) return { role: 'user', text: query };
    return text.startsWith('<') ? null : { role: 'user', text };
  }
  if (message.role === 'assistant') return { role: 'assistant', text };
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .join('\n');
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function latestMtime(files: string[]): Promise<number> {
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, (await stat(file)).mtimeMs);
    } catch {
      // Missing (e.g. no WAL yet).
    }
  }
  return latest;
}
