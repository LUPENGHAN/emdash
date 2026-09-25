import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  asRecord,
  claudeProjectDirName,
  claudeText,
  codexUserText,
  cwdVariants,
  isNoise,
  listFilesRecursive,
  openOpenCodeDb,
  parseJsonLines,
  piSessionsDir,
  type ExternalSessionEnv,
} from '../external-sessions';

/** One spoken turn of a session: what the user said or what the agent replied. */
export type TranscriptTurn = { role: 'user' | 'assistant'; text: string };

/**
 * Reads the conversation text of a provider session from the CLI's own store, leaving
 * out tool calls, tool output and injected context. Empty when the session is unknown.
 */
export async function readTranscript(
  providerId: string,
  sessionId: string,
  cwd: string,
  env: ExternalSessionEnv = { home: homedir(), env: process.env }
): Promise<TranscriptTurn[]> {
  const turns = new TurnCollector();
  if (providerId === 'claude') await readClaude(env, sessionId, cwd, turns);
  else if (providerId === 'codex') await readCodex(env, sessionId, turns);
  else if (providerId === 'opencode') readOpenCode(env, sessionId, turns);
  else if (providerId === 'pi' || providerId === 'oh-my-pi') {
    await readPiFamily(providerId, env, sessionId, turns);
  }
  return turns.list;
}

class TurnCollector {
  readonly list: TranscriptTurn[] = [];

  /** Streamed agents split one reply over several records; join consecutive ones. */
  add(role: TranscriptTurn['role'], text: string): void {
    const trimmed = text.trim();
    if (!trimmed || (role === 'user' && isNoise(trimmed))) return;
    const last = this.list[this.list.length - 1];
    if (last?.role === role) last.text += `\n\n${trimmed}`;
    else this.list.push({ role, text: trimmed });
  }
}

async function readClaude(
  { home, env }: ExternalSessionEnv,
  sessionId: string,
  cwd: string,
  turns: TurnCollector
): Promise<void> {
  const projectsRoot = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  for (const variant of await cwdVariants(cwd)) {
    const file = path.join(projectsRoot, claudeProjectDirName(variant), `${sessionId}.jsonl`);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const record of parseJsonLines(text)) {
      if (record.isSidechain || record.isMeta) continue;
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      turns.add(record.type, claudeText(asRecord(record.message)?.content));
    }
    return;
  }
}

async function readCodex(
  { home, env }: ExternalSessionEnv,
  sessionId: string,
  turns: TurnCollector
): Promise<void> {
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
  const suffix = `${sessionId}.jsonl`;
  const candidates = [
    ...(await listFilesRecursive(path.join(codexHome, 'sessions'), '.jsonl')),
    ...(await listFilesRecursive(path.join(codexHome, 'archived_sessions'), '.jsonl')),
  ];
  const file = candidates.find((candidate) => candidate.endsWith(suffix));
  if (!file) return;
  for (const record of parseJsonLines(await readFile(file, 'utf8'))) {
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const userText = codexUserText(payload);
    if (userText !== null) {
      turns.add('user', userText);
      continue;
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      turns.add('assistant', payload.message);
      continue;
    }
    const item = asRecord(payload.item);
    if (payload.type === 'item_completed' && item?.type === 'AgentMessage') {
      const content = Array.isArray(item.content) ? item.content : [];
      turns.add('assistant', content.map((part) => String(asRecord(part)?.text ?? '')).join('\n'));
    }
  }
}

async function readPiFamily(
  agent: 'pi' | 'oh-my-pi',
  env: ExternalSessionEnv,
  sessionId: string,
  turns: TurnCollector
): Promise<void> {
  // Files are named `<timestamp>_<session id>.jsonl`.
  const files = await listFilesRecursive(piSessionsDir(agent, env), '.jsonl');
  const file = files.find((candidate) => candidate.endsWith(`_${sessionId}.jsonl`));
  if (!file) return;
  for (const record of parseJsonLines(await readFile(file, 'utf8'))) {
    if (record.type !== 'message') continue;
    const message = asRecord(record.message);
    if (message?.role === 'user' || message?.role === 'assistant') {
      turns.add(message.role, claudeText(message.content));
    }
  }
}

function readOpenCode(env: ExternalSessionEnv, sessionId: string, turns: TurnCollector): void {
  let db: ReturnType<typeof openOpenCodeDb>;
  try {
    db = openOpenCodeDb(env);
  } catch {
    return;
  }
  try {
    const rows = db
      .prepare(
        `SELECT json_extract(m.data, '$.role') AS role, p.data AS part FROM message m
         JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(p.data, '$.type') = 'text'
         ORDER BY m.time_created, p.time_created`
      )
      .all(sessionId) as { role: string; part: string }[];
    for (const row of rows) {
      const part = asRecord(JSON.parse(row.part));
      // Synthetic parts are context OpenCode injected, not something either side said.
      if (!part || part.synthetic || typeof part.text !== 'string') continue;
      if (row.role === 'user' || row.role === 'assistant') turns.add(row.role, part.text);
    }
  } finally {
    db.close();
  }
}
