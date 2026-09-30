import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SubagentSummary } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import {
  asRecord,
  claudeProjectDirName,
  claudeText,
  codexUserText,
  cwdVariants,
  listFilesRecursive,
  parseJsonLines,
  type ExternalSessionEnv,
} from './external-sessions';
import { localConversation } from './handoff/prepare-conversation-handoff';
import type { TranscriptTurn } from './handoff/transcript';

/** A subagent that has not written for this long is no longer running (it was cut off). */
const STALE_MS = 10 * 60_000;
const TAIL_BYTES = 64 * 1024;
const HEAD_LIMIT_BYTES = 4 * 1024 * 1024;

const defaultEnv = (): ExternalSessionEnv => ({ home: homedir(), env: process.env });

/**
 * The subagents an agent session started inside its own process (Claude Code's Task
 * agents, Codex's spawned agents), read from the agent's own session files. Newest first.
 */
export async function listSubagents(
  providerId: string,
  sessionId: string,
  cwd: string,
  env: ExternalSessionEnv = defaultEnv()
): Promise<SubagentSummary[]> {
  const found =
    providerId === 'claude'
      ? await claudeSubagents(sessionId, cwd, env)
      : providerId === 'codex'
        ? await codexSubagents(sessionId, env)
        : [];
  return found
    .map(({ summary }) => summary)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

/** What one subagent was asked and answered, from its own transcript. */
export async function readSubagentTranscript(
  providerId: string,
  sessionId: string,
  cwd: string,
  subagentId: string,
  env: ExternalSessionEnv = defaultEnv()
): Promise<TranscriptTurn[]> {
  if (providerId === 'claude') {
    const entry = (await claudeSubagents(sessionId, cwd, env)).find(
      ({ summary }) => summary.id === subagentId
    );
    return entry ? claudeTurns(await readFile(entry.file, 'utf8')) : [];
  }
  if (providerId === 'codex') {
    const entry = (await codexSubagents(sessionId, env)).find(
      ({ summary }) => summary.id === subagentId
    );
    return entry
      ? codexTurns(await readFile(entry.file, 'utf8')).map(({ role, text }) => ({ role, text }))
      : [];
  }
  return [];
}

type Found = { summary: SubagentSummary; file: string };

// ── Claude Code: <projects>/<cwd>/<session>/subagents/agent-<id>.{jsonl,meta.json} ──

async function claudeSubagents(
  sessionId: string,
  cwd: string,
  { home, env }: ExternalSessionEnv
): Promise<Found[]> {
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  for (const variant of await cwdVariants(cwd)) {
    const dir = path.join(projects, claudeProjectDirName(variant), sessionId, 'subagents');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const found: Found[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      const file = path.join(dir, name);
      const meta = asRecord(await readJson(path.join(dir, `${id}.meta.json`)));
      const tail = await readTail(file);
      const last = tail.at(-1);
      const message = asRecord(last?.message);
      const ended = last?.type === 'assistant' && message?.stop_reason === 'end_turn';
      found.push({
        file,
        summary: {
          id,
          kind: typeof meta?.agentType === 'string' ? meta.agentType : 'agent',
          description: typeof meta?.description === 'string' ? meta.description : null,
          ...(await timing(file, await firstTimestamp(file), ended)),
        },
      });
    }
    return found;
  }
  return [];
}

function claudeTurns(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const record of parseJsonLines(text)) {
    if (record.isMeta || (record.type !== 'user' && record.type !== 'assistant')) continue;
    pushTurn(turns, record.type, claudeText(asRecord(record.message)?.content));
  }
  return turns;
}

// ── Codex: rollouts whose session_meta names this session as parent_thread_id ──────

/** Parent thread per rollout file; a rollout's first line never changes. */
const codexParents = new Map<string, { parent: string | null; meta: Record<string, unknown> }>();

async function codexSubagents(
  sessionId: string,
  { home, env }: ExternalSessionEnv
): Promise<Found[]> {
  const sessions = path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions');
  // Rollouts sit in YYYY/MM/DD folders; a subagent starts after its parent, whose id
  // (a UUIDv7) carries its creation time. A day of slack covers time zones.
  const since = uuidV7Time(sessionId);
  const days = since === null ? null : new Date(since - 86_400_000).toISOString().slice(0, 10);
  const files = (await listFilesRecursive(sessions, '.jsonl')).filter((file) => {
    if (!days) return true;
    const [year, month, day] = path.relative(sessions, file).split(path.sep);
    return !day || `${year}-${month}-${day}` >= days;
  });
  const found: Found[] = [];
  for (const file of files) {
    let entry = codexParents.get(file);
    if (!entry) {
      const meta = asRecord((await readHead(file))?.payload) ?? {};
      const parent = typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id : null;
      entry = { parent, meta };
      codexParents.set(file, entry);
    }
    if (entry.parent !== sessionId) continue;
    const source = asRecord(asRecord(entry.meta.source)?.subagent);
    // Codex's own approval reviews ("guardian") are not work the agent handed off.
    if (source?.other === 'guardian') continue;
    const spawn = asRecord(source?.thread_spawn);
    const kind =
      str(spawn?.agent_role) ?? str(spawn?.agent_nickname) ?? str(source?.other) ?? 'agent';
    const records = [...parseJsonLines(await readFile(file, 'utf8'))];
    const start = Number(entry.meta.subagent_history_start_ordinal ?? 0);
    const own = records.filter((record) => Number(record.ordinal ?? Infinity) >= start);
    const agentPath = str(spawn?.agent_path);
    const firstAsk =
      codexTurns(records).find((turn) => turn.role === 'user' && !turn.encrypted)?.text ??
      (agentPath ? taskNameOf(agentPath) : null);
    const events = own.map((record) => asRecord(record.payload)?.type);
    const lastComplete = events.lastIndexOf('task_complete');
    const lastStart = events.lastIndexOf('task_started');
    const ended = lastComplete > lastStart || events.includes('turn_aborted');
    found.push({
      file,
      summary: {
        id: str(entry.meta.id) ?? path.basename(file, '.jsonl'),
        kind,
        description: firstAsk ? firstAsk.split('\n')[0]!.slice(0, 200) : null,
        ...(await timing(file, str(entry.meta.timestamp), ended)),
      },
    });
  }
  return found;
}

/**
 * A Codex subagent's turns. Older rollouts record them as `user_message` /
 * `agent_message` events; newer ones as the task the parent sent (an `agent_message`
 * item to this agent, whose text Codex may keep only encrypted) and the agent's own
 * assistant `message` items.
 */
function codexTurns(
  source: string | Record<string, unknown>[]
): (TranscriptTurn & { encrypted?: boolean })[] {
  const records = typeof source === 'string' ? [...parseJsonLines(source)] : source;
  const meta = asRecord(records[0]?.payload);
  const start = Number(meta?.subagent_history_start_ordinal ?? 0);
  const spawn = asRecord(asRecord(asRecord(meta?.source)?.subagent)?.thread_spawn);
  const agentPath = str(spawn?.agent_path);
  const own = records.filter((record) => Number(record.ordinal ?? Infinity) >= start);
  const hasReplyEvents = own.some(
    (record) => record.type === 'event_msg' && asRecord(record.payload)?.type === 'agent_message'
  );
  const turns: (TranscriptTurn & { encrypted?: boolean })[] = [];
  for (const record of own) {
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const userText = codexUserText(payload);
    if (userText !== null) {
      pushTurn(turns, 'user', userText);
    } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      pushTurn(turns, 'assistant', payload.message);
    } else if (
      record.type === 'response_item' &&
      payload.type === 'agent_message' &&
      (!agentPath || payload.recipient === agentPath)
    ) {
      const task = interAgentPayload(payload.content);
      if (task.text) pushTurn(turns, 'user', task.text);
      else if (task.encrypted) {
        turns.push({
          role: 'user',
          text: `${agentPath ? `Task ${taskNameOf(agentPath)}: ` : ''}Codex keeps what it was asked encrypted, so it cannot be shown.`,
          encrypted: true,
        });
      }
    } else if (
      !hasReplyEvents &&
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant'
    ) {
      pushTurn(turns, 'assistant', outputText(payload.content));
    }
  }
  return turns;
}

/** The readable part of a message between Codex agents (a header, then `Payload:`). */
function interAgentPayload(content: unknown): { text: string; encrypted: boolean } {
  const parts = Array.isArray(content) ? content.map((part) => asRecord(part)) : [];
  const text = parts
    .map((part) => (part?.type === 'input_text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
  const at = text.indexOf('Payload:\n');
  return {
    text: (at >= 0 ? text.slice(at + 'Payload:\n'.length) : text).trim(),
    encrypted: parts.some((part) => part?.type === 'encrypted_content'),
  };
}

function outputText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      const p = asRecord(part);
      return p?.type === 'output_text' && typeof p.text === 'string' ? p.text : '';
    })
    .join('\n');
}

/** "/root/review_windows_audit" → "review windows audit". */
function taskNameOf(agentPath: string): string {
  return (agentPath.split('/').pop() ?? agentPath).replace(/_/g, ' ');
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function pushTurn(turns: TranscriptTurn[], role: TranscriptTurn['role'], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = turns.at(-1);
  if (last?.role === role) last.text += `\n\n${trimmed}`;
  else turns.push({ role, text: trimmed });
}

async function timing(
  file: string,
  startedAt: string | null,
  ended: boolean
): Promise<Pick<SubagentSummary, 'status' | 'startedAt' | 'updatedAt'>> {
  const modified = (await stat(file)).mtimeMs;
  return {
    status: ended || Date.now() - modified > STALE_MS ? 'done' : 'running',
    startedAt,
    updatedAt: new Date(modified).toISOString(),
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The first record, however long (Codex's session_meta carries its instructions). */
async function readHead(file: string): Promise<Record<string, unknown> | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const chunks: Buffer[] = [];
    for (let position = 0; position < HEAD_LIMIT_BYTES; ) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      if (newline >= 0) break;
      position += bytesRead;
    }
    return [...parseJsonLines(Buffer.concat(chunks).toString('utf8'))][0] ?? null;
  } finally {
    await handle.close();
  }
}

/** The records at the end of a (possibly large) transcript; the cut first line is dropped. */
async function readTail(file: string): Promise<Record<string, unknown>[]> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return [...parseJsonLines(size > length ? text.slice(text.indexOf('\n') + 1) : text)];
  } finally {
    await handle.close();
  }
}

async function firstTimestamp(file: string): Promise<string | null> {
  return str((await readHead(file))?.timestamp);
}

function uuidV7Time(id: string): number | null {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return null;
  return Number.parseInt(hex.slice(0, 12), 16);
}

/** The subagents of a conversation on this computer (remote ones: none, for now). */
export async function listConversationSubagents(
  db: Pick<AppDb, 'select'>,
  conversationId: string
): Promise<SubagentSummary[]> {
  const row = await localConversation(db, conversationId).catch(() => null);
  if (!row?.providerSessionId) return [];
  return listSubagents(row.provider, row.providerSessionId, row.cwd);
}

export async function readConversationSubagentTranscript(
  db: Pick<AppDb, 'select'>,
  conversationId: string,
  subagentId: string
): Promise<TranscriptTurn[]> {
  const row = await localConversation(db, conversationId);
  if (!row.providerSessionId) return [];
  return readSubagentTranscript(row.provider, row.providerSessionId, row.cwd, subagentId);
}
