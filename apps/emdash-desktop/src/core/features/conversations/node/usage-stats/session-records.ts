import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { asRecord, claudeText, listFilesRecursive } from '../external-sessions';
import {
  estimateTokens,
  usageCost,
  ZERO_USAGE,
  type PriceCatalog,
  type Usage,
} from '../session-cost';

export type UsageAgent = 'claude' | 'codex' | 'pi' | 'oh-my-pi';

/** One day's calls in one file on one model (and, for Pi, one provider). */
export type UsageBucket = {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  model: string;
  /** The provider the agent itself names for the calls (Pi: anthropic, openrouter…). */
  vendor: string | null;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** At the vendors' list prices, in USD; null when the model had no known price. */
  listUsd: number | null;
};

/** The calls one session file records. */
export type FileUsage = {
  agent: UsageAgent;
  /** The session the calls belong to; a subagent's are its parent's. */
  sessionId: string | null;
  cwd: string | null;
  buckets: UsageBucket[];
};

/** A session file and the calls it records. */
export type ScannedFile = { path: string; usage: FileUsage };

/** A directory of one agent's session files. */
export type SessionRoot = { agent: UsageAgent; dir: string };

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local calendar day of a record's timestamp (ISO text or epoch milliseconds). */
export function localDay(timestamp: unknown): string | null {
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The file's records that may carry usage, parsed. Session files run to 100 MB, mostly
 * tool output: lines without any of `needles` are skipped before parsing.
 */
async function* records(
  file: string,
  needles: readonly string[]
): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!needles.some((needle) => line.includes(needle))) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const record = asRecord(parsed);
        if (record) yield record;
      } catch {
        // A line still being written, or not JSON.
      }
    }
  } finally {
    lines.close();
  }
}

/** Sums timed usages into day/model/vendor buckets, priced at list prices. */
export function bucketize(
  usages: { usage: Usage; day: string; vendor: string | null }[],
  catalog: PriceCatalog
): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const { usage, day, vendor } of usages) {
    const key = `${day}\u0000${usage.model}\u0000${vendor ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        day,
        model: usage.model,
        vendor,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        listUsd: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.requests += 1;
    bucket.input += usage.input;
    bucket.output += usage.output;
    bucket.cacheRead += usage.cacheRead;
    bucket.cacheWrite += usage.cacheWrite5m + usage.cacheWrite1h;
    const cost = usageCost(usage, catalog);
    bucket.listUsd = cost === null || bucket.listUsd === null ? null : bucket.listUsd + cost;
  }
  return [...buckets.values()];
}

type Timed = { usage: Usage; day: string; vendor: string | null };

/** Claude Code: one usage per API response (several records share it), and compactions. */
export async function claudeFileUsage(file: string, catalog: PriceCatalog): Promise<FileUsage> {
  const byMessage = new Map<string, Timed>();
  const compactions: Timed[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let compaction: Timed | null = null;
  for await (const record of records(file, ['"usage"', 'compact_boundary', 'isCompactSummary'])) {
    sessionId ??= str(record.sessionId);
    cwd ??= str(record.cwd);
    const day = localDay(record.timestamp);
    // A compaction reads the whole context (mostly cached) and writes the summary that
    // follows its boundary; Claude Code records neither, so both are estimated.
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const context = num(asRecord(record.compactMetadata)?.preTokens);
      if (!model || context === 0 || !day) continue;
      compaction = {
        usage: { ...ZERO_USAGE, model, cacheRead: context, compaction: true },
        day,
        vendor: null,
      };
      compactions.push(compaction);
      continue;
    }
    if (record.isCompactSummary && compaction) {
      compaction.usage.output = estimateTokens(claudeText(asRecord(record.message)?.content));
      compaction = null;
      continue;
    }
    if (record.type !== 'assistant' || !day) continue;
    const message = asRecord(record.message);
    const usage = asRecord(message?.usage);
    if (!message || !usage || typeof message.model !== 'string') continue;
    if (message.model.startsWith('<')) continue; // "<synthetic>" local messages
    model = message.model;
    const creation = asRecord(usage.cache_creation);
    const oneHour = num(creation?.ephemeral_1h_input_tokens);
    const written = num(usage.cache_creation_input_tokens);
    byMessage.set(String(message.id ?? record.uuid), {
      usage: {
        model: message.model,
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite5m: creation ? num(creation.ephemeral_5m_input_tokens) : written - oneHour,
        cacheWrite1h: oneHour,
      },
      day,
      vendor: null,
    });
  }
  return {
    agent: 'claude',
    sessionId,
    cwd,
    buckets: bucketize([...byMessage.values(), ...compactions], catalog),
  };
}

/** Codex: per-call usage from the running token totals; a spawned agent counts for its parent. */
export async function codexFileUsage(file: string, catalog: PriceCatalog): Promise<FileUsage> {
  let sessionId: string | null = null;
  let parentId: string | null = null;
  let cwd: string | null = null;
  let vendor: string | null = null;
  let model = '';
  let previous = { input: 0, cached: 0, written: 0, output: 0 };
  const usages: Timed[] = [];
  for await (const record of records(file, ['session_meta', 'turn_context', 'token_count'])) {
    const payload = asRecord(record.payload);
    if (!payload) continue;
    if (record.type === 'session_meta') {
      sessionId ??= str(payload.id);
      parentId ??= str(payload.parent_thread_id);
      cwd ??= str(payload.cwd);
      vendor ??= str(payload.model_provider);
      continue;
    }
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      continue;
    }
    if (payload.type !== 'token_count') continue;
    const info = asRecord(payload.info);
    const total = asRecord(info?.total_token_usage);
    const day = localDay(record.timestamp);
    if (!total || !day) continue;
    const current = {
      input: num(total.input_tokens),
      cached: num(total.cached_input_tokens),
      written: num(total.cache_write_input_tokens),
      output: num(total.output_tokens),
    };
    const delta = {
      input: current.input - previous.input,
      cached: current.cached - previous.cached,
      written: current.written - previous.written,
      output: current.output - previous.output,
    };
    previous = current;
    if (delta.input <= 0 && delta.output <= 0) continue;
    usages.push({
      usage: {
        model: model || 'unknown',
        input: Math.max(0, delta.input - delta.cached - delta.written),
        output: Math.max(0, delta.output),
        cacheRead: Math.max(0, delta.cached),
        cacheWrite5m: Math.max(0, delta.written),
        cacheWrite1h: 0,
        context: num(asRecord(info?.last_token_usage)?.input_tokens),
      },
      day,
      vendor,
    });
  }
  return {
    agent: 'codex',
    sessionId: parentId ?? sessionId,
    cwd,
    buckets: bucketize(usages, catalog).map((bucket) => ({ ...bucket, vendor })),
  };
}

/** Pi / Oh My Pi: every assistant message records its usage and the provider it used. */
export async function piFileUsage(
  agent: 'pi' | 'oh-my-pi',
  file: string,
  catalog: PriceCatalog
): Promise<FileUsage> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  const usages: Timed[] = [];
  for await (const record of records(file, ['"usage"', '"type":"session"'])) {
    if (record.type === 'session') {
      sessionId ??= str(record.id);
      cwd ??= str(record.cwd);
      continue;
    }
    const message = asRecord(record.message);
    const usage = asRecord(message?.usage);
    if (record.type !== 'message' || message?.role !== 'assistant' || !usage) continue;
    const day = localDay(record.timestamp ?? message.timestamp);
    if (!day) continue;
    const tokens = num(usage.input) + num(usage.output) + num(usage.cacheRead);
    if (tokens + num(usage.cacheWrite) === 0) continue; // aborted before any call
    usages.push({
      usage: {
        model: typeof message.model === 'string' ? message.model : 'unknown',
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite5m: num(usage.cacheWrite),
        cacheWrite1h: 0,
      },
      day,
      vendor: str(message.provider),
    });
  }
  return { agent, sessionId, cwd, buckets: bucketize(usages, catalog) };
}

function fileUsage(agent: UsageAgent, file: string, catalog: PriceCatalog): Promise<FileUsage> {
  if (agent === 'claude') return claudeFileUsage(file, catalog);
  if (agent === 'codex') return codexFileUsage(file, catalog);
  return piFileUsage(agent, file, catalog);
}

/** Bumped when what a file's usage holds changes, so the cache is read afresh. */
const CACHE_VERSION = 1;

type CacheFile = {
  version: number;
  /** The prices the files were read at: other prices mean reading them again. */
  catalogKey?: string;
  files: Record<string, { key: string; usage: FileUsage }>;
};

/** A cheap fingerprint of a price list, which changes when any price does. */
export function catalogFingerprint(catalog: PriceCatalog): string {
  let sum = 0;
  let index = 0;
  for (const [id, price] of catalog) {
    index += 1;
    const weight = (index % 97) + id.length;
    sum +=
      weight *
      (price.input +
        price.output * 3 +
        (price.cacheRead ?? 0) * 7 +
        (price.cacheWrite ?? 0) * 11 +
        (price.longContext?.input ?? 0) * 13);
  }
  return `${catalog.size}:${sum.toFixed(6)}`;
}

/**
 * Every session file's calls, kept per file and read again only when the file changes:
 * the first scan reads every agent's whole history (gigabytes), later ones what moved.
 * Scans run one at a time; callers during one share it.
 */
export function createUsageScanner(deps: {
  cacheFile: string;
  roots: () => Promise<SessionRoot[]>;
  catalog: () => Promise<PriceCatalog>;
  warn?: (message: string, details: Record<string, unknown>) => void;
}) {
  let cache: CacheFile | null = null;
  let running: Promise<ScannedFile[]> | null = null;

  const load = async (): Promise<CacheFile> => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(deps.cacheFile, 'utf8')) as CacheFile;
      cache = parsed.version === CACHE_VERSION ? parsed : { version: CACHE_VERSION, files: {} };
    } catch {
      cache = { version: CACHE_VERSION, files: {} };
    }
    return cache;
  };

  const run = async (): Promise<ScannedFile[]> => {
    const current = await load();
    const catalog = await deps.catalog();
    const catalogKey = catalogFingerprint(catalog);
    if (current.catalogKey !== catalogKey) {
      // Priced at other prices: read every file again (a few seconds).
      current.files = {};
      current.catalogKey = catalogKey;
    }
    const seen = new Set<string>();
    let changed = false;
    const results: ScannedFile[] = [];
    for (const root of await deps.roots()) {
      for (const file of await listFilesRecursive(root.dir, '.jsonl')) {
        if (seen.has(file)) continue;
        seen.add(file);
        let key: string;
        try {
          const info = await stat(file);
          key = `${root.agent}:${info.mtimeMs}:${info.size}`;
        } catch {
          continue;
        }
        const cached = current.files[file];
        if (cached?.key === key) {
          results.push({ path: file, usage: cached.usage });
          continue;
        }
        try {
          const usage = await fileUsage(root.agent, file, catalog);
          current.files[file] = { key, usage };
          results.push({ path: file, usage });
          changed = true;
        } catch (error) {
          deps.warn?.('usage stats: could not read a session file', {
            file,
            error: String(error),
          });
        }
      }
    }
    for (const file of Object.keys(current.files)) {
      if (!seen.has(file)) {
        delete current.files[file];
        changed = true;
      }
    }
    if (changed) {
      await mkdir(path.dirname(deps.cacheFile), { recursive: true });
      await writeFile(deps.cacheFile, JSON.stringify(current));
    }
    return results;
  };

  return {
    /** Every session file's usage, reading the files changed since the last scan. */
    scan(): Promise<ScannedFile[]> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export type UsageScanner = ReturnType<typeof createUsageScanner>;
