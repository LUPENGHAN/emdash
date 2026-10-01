import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  CompactedSegment,
  CompactedSegmentTranscript,
} from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import {
  asRecord,
  claudeProjectDirName,
  claudeText,
  cwdVariants,
  isNoise,
  parseJsonLines,
  type ExternalSessionEnv,
} from './external-sessions';
import { localConversation } from './handoff/prepare-conversation-handoff';

type Turn = CompactedSegmentTranscript['turns'][number];
type Parsed = { segments: CompactedSegment[]; transcripts: CompactedSegmentTranscript[] };

const defaultEnv = (): ExternalSessionEnv => ({ home: homedir(), env: process.env });
const TOOL_INPUT_MAX = 200;
const PROMPT_MAX = 140;

/** Parsed session files by path, while unchanged; long sessions run to 100 MB. */
const cache = new Map<string, { key: string; parsed: Parsed }>();
const CACHE_FILES = 4;

/**
 * The stretches of a Claude Code session that ended in a context compaction, oldest
 * first. Claude Code keeps them in its session file but resumes (and replays to a
 * reopened chat) only what follows the last one. Empty for other agents, or a session
 * never compacted.
 */
export async function compactedSegments(
  providerId: string,
  sessionId: string,
  cwd: string,
  env: ExternalSessionEnv = defaultEnv()
): Promise<CompactedSegment[]> {
  if (providerId !== 'claude') return [];
  return (await parsedClaudeSession(sessionId, cwd, env))?.segments ?? [];
}

/** What was said in one of those stretches, and the summary the agent carried on with. */
export async function readCompactedSegment(
  providerId: string,
  sessionId: string,
  cwd: string,
  index: number,
  env: ExternalSessionEnv = defaultEnv()
): Promise<CompactedSegmentTranscript | null> {
  if (providerId !== 'claude') return null;
  return (await parsedClaudeSession(sessionId, cwd, env))?.transcripts[index] ?? null;
}

export async function listConversationCompactedSegments(
  db: Pick<AppDb, 'select'>,
  conversationId: string
): Promise<CompactedSegment[]> {
  const row = await localConversation(db, conversationId).catch(() => null);
  if (!row?.providerSessionId) return [];
  return compactedSegments(row.provider, row.providerSessionId, row.cwd);
}

export async function readConversationCompactedSegment(
  db: Pick<AppDb, 'select'>,
  conversationId: string,
  index: number
): Promise<CompactedSegmentTranscript | null> {
  const row = await localConversation(db, conversationId);
  if (!row.providerSessionId) return null;
  return readCompactedSegment(row.provider, row.providerSessionId, row.cwd, index);
}

async function parsedClaudeSession(
  sessionId: string,
  cwd: string,
  { home, env }: ExternalSessionEnv
): Promise<Parsed | null> {
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  for (const variant of await cwdVariants(cwd)) {
    const file = path.join(projects, claudeProjectDirName(variant), `${sessionId}.jsonl`);
    let key: string;
    try {
      const info = await stat(file);
      key = `${info.mtimeMs}:${info.size}`;
    } catch {
      continue;
    }
    const cached = cache.get(file);
    if (cached?.key === key) return cached.parsed;
    const text = await readFile(file, 'utf8');
    // Most sessions never compact: skip parsing them.
    const parsed = text.includes('"compact_boundary"')
      ? parseClaudeSession(text)
      : { segments: [], transcripts: [] };
    cache.delete(file);
    cache.set(file, { key, parsed });
    if (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value!);
    return parsed;
  }
  return null;
}

/** Splits a Claude Code session file at its compaction boundaries. */
export function parseClaudeSession(text: string): Parsed {
  const segments: CompactedSegment[] = [];
  const transcripts: CompactedSegmentTranscript[] = [];
  let turns: Turn[] = [];
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let firstPrompt: string | null = null;
  let awaitingSummary: CompactedSegmentTranscript | null = null;

  for (const record of parseJsonLines(text)) {
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const meta = asRecord(record.compactMetadata);
      const trigger = meta?.trigger === 'auto' || meta?.trigger === 'manual' ? meta.trigger : null;
      segments.push({
        index: segments.length,
        startedAt,
        endedAt: endedAt ?? timestamp,
        firstPrompt,
        turns: turns.length,
        trigger,
        contextTokens: typeof meta?.preTokens === 'number' ? meta.preTokens : null,
      });
      awaitingSummary = { turns, summary: null };
      transcripts.push(awaitingSummary);
      turns = [];
      startedAt = endedAt = firstPrompt = null;
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (record.isMeta || record.isSidechain) continue;
    const content = asRecord(record.message)?.content;
    if (record.isCompactSummary) {
      if (awaitingSummary) awaitingSummary.summary = claudeText(content) || null;
      awaitingSummary = null;
      continue;
    }
    startedAt ??= timestamp;
    if (timestamp) endedAt = timestamp;
    if (record.type === 'user') {
      const said = claudeText(content);
      if (isNoise(said)) continue;
      firstPrompt ??= clip(said, PROMPT_MAX);
      push(turns, 'user', said);
    } else {
      push(turns, 'assistant', assistantText(content));
    }
  }
  return { segments, transcripts };
}

/** The agent's words, with each tool it used as one line ("▸ Bash: npm test"). */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    if (b?.type === 'tool_use' && typeof b.name === 'string') {
      const detail = toolDetail(asRecord(b.input));
      parts.push(`▸ ${b.name}${detail ? `: ${detail}` : ''}`);
    }
  }
  return parts.join('\n');
}

function toolDetail(input: Record<string, unknown> | null): string {
  if (!input) return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return clip(value, TOOL_INPUT_MAX);
  }
  return '';
}

/** Streamed replies span several records, and tool steps sit between them: join a role's run. */
function push(turns: Turn[], role: Turn['role'], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = turns.at(-1);
  if (last?.role === role) last.text += `\n${trimmed}`;
  else turns.push({ role, text: trimmed });
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
