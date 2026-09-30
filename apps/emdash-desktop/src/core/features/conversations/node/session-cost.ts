import { open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionCost } from '@core/primitives/conversations/api';
import { piSessionId } from './delete-agent-session';
import {
  asRecord,
  claudeProjectDirName,
  cwdVariants,
  listFilesRecursive,
  parseJsonLines,
  piSessionsDir,
  type ExternalSessionEnv,
} from './external-sessions';

/** USD per million tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Prices once a request's context is over `above` tokens (OpenAI's long context). */
  longContext?: { above: number; input: number; output: number; cacheRead?: number };
};

/** Model id → price, first-party vendors' ids first, then every other listing. */
export type PriceCatalog = Map<string, ModelPrice>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const REFRESH_MS = 24 * 60 * 60_000;
/** Vendors whose own listing wins when several list the same model id. */
const FIRST_PARTY = ['anthropic', 'openai', 'deepseek', 'google', 'moonshotai', 'zhipuai', 'xai'];

type Env = ExternalSessionEnv;
const defaultEnv = (): Env => ({ home: homedir(), env: process.env });

/** Token counts of one request (or a run of them on one model). */
type Usage = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** The request's context size, for long-context prices. */
  context?: number;
};

// ── Prices ──────────────────────────────────────────────────────────────────────

/** Builds the catalog from models.dev's api.json. */
export function parseModelsDev(data: unknown): PriceCatalog {
  const catalog: PriceCatalog = new Map();
  const providers = asRecord(data) ?? {};
  const order = [
    ...FIRST_PARTY.filter((id) => id in providers),
    ...Object.keys(providers).filter((id) => !FIRST_PARTY.includes(id)),
  ];
  for (const providerId of order) {
    const models = asRecord(asRecord(providers[providerId])?.models) ?? {};
    for (const [id, model] of Object.entries(models)) {
      if (catalog.has(id)) continue;
      const cost = asRecord(asRecord(model)?.cost);
      if (typeof cost?.input !== 'number' || typeof cost.output !== 'number') continue;
      const over = asRecord(cost.context_over_200k);
      const tier = (Array.isArray(cost.tiers) ? cost.tiers : [])
        .map((entry) => asRecord(entry))
        .find((entry) => asRecord(entry?.tier)?.type === 'context');
      const long = tier ?? over;
      const above = Number(asRecord(tier?.tier)?.size ?? (over ? 200_000 : 0));
      catalog.set(id, {
        input: cost.input,
        output: cost.output,
        ...(typeof cost.cache_read === 'number' && { cacheRead: cost.cache_read }),
        ...(typeof cost.cache_write === 'number' && { cacheWrite: cost.cache_write }),
        ...(long &&
          typeof long.input === 'number' &&
          typeof long.output === 'number' &&
          above > 0 && {
            longContext: {
              above,
              input: long.input,
              output: long.output,
              ...(typeof long.cache_read === 'number' && { cacheRead: long.cache_read }),
            },
          }),
      });
    }
  }
  return catalog;
}

/**
 * Model prices from models.dev (the catalog OpenCode uses), refreshed daily and kept in
 * `cacheFile` for offline use.
 */
export function createPriceCatalog(deps: {
  cacheFile: string;
  fetchJson?: () => Promise<unknown>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const fetchJson =
    deps.fetchJson ??
    (async () => {
      const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`models.dev: ${response.status}`);
      return response.json();
    });
  let loaded: { catalog: PriceCatalog; fetchedAt: number } | null = null;
  let refreshing: Promise<void> | null = null;

  const refresh = () =>
    (refreshing ??= (async () => {
      try {
        const data = await fetchJson();
        const catalog = parseModelsDev(data);
        if (catalog.size === 0) return;
        loaded = { catalog, fetchedAt: now() };
        await writeFile(
          deps.cacheFile,
          JSON.stringify({ fetchedAt: loaded.fetchedAt, prices: [...catalog] })
        ).catch(() => undefined);
      } catch {
        // Offline: keep what we have.
      }
    })().finally(() => {
      refreshing = null;
    }));

  return async (): Promise<PriceCatalog> => {
    if (!loaded) {
      try {
        const cached = JSON.parse(await readFile(deps.cacheFile, 'utf8')) as {
          fetchedAt: number;
          prices: [string, ModelPrice][];
        };
        loaded = { catalog: new Map(cached.prices), fetchedAt: cached.fetchedAt };
      } catch {
        await refresh();
      }
    }
    if (loaded && now() - loaded.fetchedAt > REFRESH_MS) void refresh();
    return loaded?.catalog ?? new Map();
  };
}

/** The price of a model as agents name it (`opus[1m]`-style suffixes, `vendor/` prefixes). */
export function priceOf(catalog: PriceCatalog, model: string): ModelPrice | undefined {
  const bare = model.replace(/\[[^\]]*\]$/, '').replace(/:[a-z]+$/i, '');
  return catalog.get(bare) ?? catalog.get(bare.split('/').pop() ?? bare);
}

function costOf(usage: Usage, price: ModelPrice): number {
  const long =
    price.longContext && (usage.context ?? 0) > price.longContext.above
      ? price.longContext
      : undefined;
  const input = long?.input ?? price.input;
  const output = long?.output ?? price.output;
  const cacheRead = long?.cacheRead ?? price.cacheRead ?? input;
  const cacheWrite = price.cacheWrite ?? input * 1.25;
  return (
    (usage.input * input +
      usage.output * output +
      usage.cacheRead * cacheRead +
      usage.cacheWrite5m * cacheWrite +
      // Anthropic's one-hour cache writes cost twice the input price.
      usage.cacheWrite1h * input * 2) /
    1_000_000
  );
}

/** What a session's token usage would cost at the vendors' API list prices. */
export function priceUsage(usages: Usage[], catalog: PriceCatalog): SessionCost {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let amount = 0;
  let priced = 0;
  const unpriced = new Set<string>();
  for (const usage of usages) {
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite5m + usage.cacheWrite1h;
    const price = priceOf(catalog, usage.model);
    if (!price) {
      unpriced.add(usage.model);
      continue;
    }
    amount += costOf(usage, price);
    priced += 1;
  }
  return {
    amount: priced > 0 ? amount : null,
    currency: 'USD',
    tokens,
    unpricedModels: [...unpriced],
  };
}

// ── Usage in each agent's own session files ─────────────────────────────────────

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Claude Code: its transcript plus its Task agents', one usage per API message. */
async function claudeUsage(sessionId: string, cwd: string, { home, env }: Env): Promise<Usage[]> {
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  for (const variant of await cwdVariants(cwd)) {
    const dir = path.join(projects, claudeProjectDirName(variant));
    const main = path.join(dir, `${sessionId}.jsonl`);
    const files = [
      main,
      ...(await listFilesRecursive(path.join(dir, sessionId, 'subagents'), '.jsonl')),
    ];
    const byMessage = new Map<string, Usage>();
    let found = false;
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      found = true;
      for (const record of parseJsonLines(text)) {
        if (record.type !== 'assistant') continue;
        const message = asRecord(record.message);
        const usage = asRecord(message?.usage);
        if (!message || !usage || typeof message.model !== 'string') continue;
        if (message.model.startsWith('<')) continue; // "<synthetic>" local messages
        const creation = asRecord(usage.cache_creation);
        const oneHour = num(creation?.ephemeral_1h_input_tokens);
        const written = num(usage.cache_creation_input_tokens);
        // One API response spans several records sharing its id and usage.
        byMessage.set(`${file}\0${String(message.id ?? record.uuid)}`, {
          model: message.model,
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite5m: creation ? num(creation.ephemeral_5m_input_tokens) : written - oneHour,
          cacheWrite1h: oneHour,
        });
      }
    }
    if (found) return [...byMessage.values()];
  }
  return [];
}

/** Codex: the thread's rollout and its spawned agents', from the running token totals. */
async function codexUsage(sessionId: string, { home, env }: Env): Promise<Usage[]> {
  const sessions = path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions');
  const files = await listFilesRecursive(sessions, '.jsonl');
  const own = files.filter((file) => file.endsWith(`-${sessionId}.jsonl`));
  if (own.length === 0) return [];
  const children: string[] = [];
  for (const file of files) {
    if (own.includes(file)) continue;
    // A spawned agent's first line names this thread as its parent.
    const head = await firstLine(file);
    if (!head?.includes(sessionId)) continue;
    if (asRecord(asRecord(safeJson(head))?.payload)?.parent_thread_id === sessionId) {
      children.push(file);
    }
  }
  const usages: Usage[] = [];
  for (const file of [...own, ...children]) {
    let model = '';
    let previous = { input: 0, cached: 0, written: 0, output: 0 };
    for (const record of parseJsonLines(await readFile(file, 'utf8').catch(() => ''))) {
      const payload = asRecord(record.payload);
      if (record.type === 'turn_context' && typeof payload?.model === 'string') {
        model = payload.model;
        continue;
      }
      if (payload?.type !== 'token_count') continue;
      const info = asRecord(payload.info);
      const total = asRecord(info?.total_token_usage);
      if (!total) continue;
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
        model: model || 'unknown',
        input: Math.max(0, delta.input - delta.cached - delta.written),
        output: Math.max(0, delta.output),
        cacheRead: Math.max(0, delta.cached),
        cacheWrite5m: Math.max(0, delta.written),
        cacheWrite1h: 0,
        context: num(asRecord(info?.last_token_usage)?.input_tokens),
      });
    }
  }
  return usages;
}

/** Pi / Oh My Pi: every assistant message records its usage. */
async function piFamilyUsage(
  agent: 'pi' | 'oh-my-pi',
  sessionId: string,
  env: Env
): Promise<Usage[]> {
  const root = piSessionsDir(agent, env);
  let file: string | null = null;
  if (path.isAbsolute(sessionId)) {
    const inside = path.relative(root, sessionId);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) file = sessionId;
  } else {
    for (const candidate of await listFilesRecursive(root, '.jsonl')) {
      if ((await piSessionId(candidate).catch(() => null)) === sessionId) {
        file = candidate;
        break;
      }
    }
  }
  if (!file) return [];
  const usages: Usage[] = [];
  for (const record of parseJsonLines(await readFile(file, 'utf8').catch(() => ''))) {
    const message = asRecord(record.message);
    const usage = asRecord(message?.usage);
    if (record.type !== 'message' || message?.role !== 'assistant' || !usage) continue;
    usages.push({
      model: typeof message.model === 'string' ? message.model : 'unknown',
      input: num(usage.input),
      output: num(usage.output),
      cacheRead: num(usage.cacheRead),
      cacheWrite5m: num(usage.cacheWrite),
      cacheWrite1h: 0,
    });
  }
  return usages;
}

async function firstLine(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const chunks: Buffer[] = [];
    for (let position = 0; position < 4 * 1024 * 1024; ) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      if (newline >= 0) break;
      position += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Agents whose sessions record token usage Emdash can price. */
export const COSTED_AGENTS = new Set(['claude', 'codex', 'pi', 'oh-my-pi']);

/**
 * What a session has used, and what that would cost at API list prices: the
 * equivalent of a subscription's usage, or an estimate of a provider's bill. Null for
 * agents whose sessions record no usage.
 */
export async function sessionCost(
  providerId: string,
  sessionId: string,
  cwd: string,
  catalog: PriceCatalog,
  env: Env = defaultEnv()
): Promise<SessionCost | null> {
  const usages =
    providerId === 'claude'
      ? await claudeUsage(sessionId, cwd, env)
      : providerId === 'codex'
        ? await codexUsage(sessionId, env)
        : providerId === 'pi' || providerId === 'oh-my-pi'
          ? await piFamilyUsage(providerId, sessionId, env)
          : null;
  if (!usages || usages.length === 0) return null;
  return priceUsage(usages, catalog);
}
