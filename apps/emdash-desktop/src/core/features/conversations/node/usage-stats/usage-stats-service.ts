import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentDisplayName,
  ownSourceKey,
  usagePricingSchema,
  type ModelPriceValue,
  type UsageBilling,
  type UsagePricing,
  type UsageReport,
  type UsageRow,
  type UsageSource,
} from '@core/features/usage-stats/api';
import { costAt, priceOf, usageCost, type ModelPrice, type PriceCatalog } from '../session-cost';
import type { FileUsage, ScannedFile, UsageBucket, UsageScanner } from './session-records';

/** What Emdash knows about the sessions it started, and the sources it can run agents on. */
export type UsageAttribution = {
  /** Emdash's conversations by their agent session id (Pi: also by session file path). */
  conversations: Map<string, { modelSource: string | null | undefined; project: string | null }>;
  /** Each agent's default source in its settings: a provider id, or absent for its own. */
  agentDefaults: Record<string, string | undefined>;
  providers: {
    id: string;
    name: string;
    account?: { agent: string };
    /** The name Emdash gives it in an agent's config at launch (Pi, Codex record it per call). */
    configId?: string;
  }[];
};

/** Another computer's Emdash, reached over its Remote access with a saved sign-in. */
export type UsageRemote = { name: string; baseUrl: string; token: string };

/** A computer's own rows, as its Remote access answers `/usage-stats`. */
export type LocalUsage = { machine: string; rows: UsageRow[]; unpricedModels: string[] };

const REMOTE_TIMEOUT_MS = 120_000;

/** Pi and Oh My Pi providers that are a subscription's sign-in, not a key billed per call. */
const SUBSCRIPTION_VENDORS = new Set([
  'openai-codex',
  'github-copilot',
  'google-gemini-cli',
  'google-antigravity',
]);

/** Where the calls went, and how that source bills by default. */
type ResolvedSource = { key: string; name: string; defaultBilling: UsageBilling };

function ownSource(agent: string, vendor: string | null): ResolvedSource {
  const name = `${agentDisplayName(agent)} · own configuration${vendor ? ` (${vendor})` : ''}`;
  const subscription =
    agent === 'claude'
      ? true
      : agent === 'codex'
        ? !vendor || vendor === 'openai'
        : vendor !== null && SUBSCRIPTION_VENDORS.has(vendor);
  return {
    key: ownSourceKey(agent, agent === 'claude' ? null : vendor),
    name,
    defaultBilling: subscription ? 'subscription' : 'usage',
  };
}

/** The source a file's calls ran on: what Emdash launched them with, or the agent's own. */
export function resolveSource(
  file: FileUsage,
  filePath: string,
  vendor: string | null,
  attribution: UsageAttribution
): ResolvedSource {
  // The agent recorded the provider Emdash launched it on: that settles it.
  const launched = vendor
    ? attribution.providers.find((provider) => provider.configId === vendor)
    : undefined;
  if (launched) {
    return {
      key: launched.id,
      name: launched.name,
      defaultBilling: launched.account ? 'subscription' : 'usage',
    };
  }
  const conversation =
    (file.sessionId && attribution.conversations.get(file.sessionId)) ||
    attribution.conversations.get(filePath);
  // Sessions started outside Emdash run on the agent's own configuration.
  const chosen = conversation
    ? conversation.modelSource !== undefined
      ? conversation.modelSource
      : (attribution.agentDefaults[file.agent] ?? null)
    : null;
  if (typeof chosen !== 'string') return ownSource(file.agent, vendor);
  const provider = attribution.providers.find((candidate) => candidate.id === chosen);
  return {
    key: chosen,
    name: provider?.name ?? `${chosen} (removed)`,
    defaultBilling: provider?.account ? 'subscription' : 'usage',
  };
}

/** A project's name from a session's directory: Emdash's worktrees are `<Name>-<hash>/<branch>`. */
export function projectFromCwd(cwd: string | null): string {
  if (!cwd) return '—';
  const worktree = /[\\/]worktrees[\\/]([^\\/]+?)-[0-9a-f]{8}(?:[\\/]|$)/.exec(cwd);
  if (worktree) return worktree[1]!;
  return path.basename(cwd) || cwd;
}

/** A bucket's tokens as one request's, for pricing them at another price. */
function bucketUsage(bucket: UsageBucket) {
  return {
    model: bucket.model,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite5m: bucket.cacheWrite,
    cacheWrite1h: 0,
  };
}

/**
 * A bucket's list price: at a price set by hand, else as read (or priced now if the
 * model had no known price then).
 */
function listUsdOf(
  bucket: UsageBucket,
  catalog: PriceCatalog,
  manual: Record<string, ModelPrice>
): number | null {
  const override = manual[bucket.model];
  if (override) return costAt(bucketUsage(bucket), override);
  if (bucket.listUsd !== null) return bucket.listUsd;
  return usageCost(bucketUsage(bucket), catalog);
}

/**
 * This computer's calls between two local days (inclusive), each priced the way its
 * source bills: per call at the source's rate, or nothing more on a subscription (with
 * the list-price equivalent kept for comparison).
 */
export function buildRows(input: {
  machine: string;
  files: ScannedFile[];
  from: string;
  to: string;
  attribution: UsageAttribution;
  pricing: UsagePricing;
  catalog: PriceCatalog;
}): { rows: UsageRow[]; unpricedModels: string[]; sources: UsageSource[] } {
  const rows = new Map<string, UsageRow>();
  const unpriced = new Set<string>();
  const sources = new Map<string, UsageSource>();
  for (const { path: filePath, usage } of input.files) {
    const project =
      ((usage.sessionId && input.attribution.conversations.get(usage.sessionId)?.project) ||
        input.attribution.conversations.get(filePath)?.project) ??
      projectFromCwd(usage.cwd);
    for (const bucket of usage.buckets) {
      const source = resolveSource(usage, filePath, bucket.vendor, input.attribution);
      sources.set(source.key, {
        key: source.key,
        name: source.name,
        defaultBilling: source.defaultBilling,
      });
      if (bucket.day < input.from || bucket.day > input.to) continue;
      const settings = input.pricing.sources[source.key] ?? {};
      const billing = settings.billing ?? source.defaultBilling;
      const currency = settings.currency ?? 'USD';
      const listUsd = listUsdOf(bucket, input.catalog, input.pricing.models);
      if (listUsd === null) unpriced.add(bucket.model);
      const amount =
        billing === 'usage' && listUsd !== null ? listUsd * (settings.multiplier ?? 1) : null;
      const key = [bucket.day, usage.agent, bucket.model, source.key, project, currency].join(
        '\u0000'
      );
      const row = rows.get(key);
      if (!row) {
        rows.set(key, {
          machine: input.machine,
          day: bucket.day,
          agent: usage.agent,
          model: bucket.model,
          source: source.key,
          sourceName: source.name,
          billing,
          project,
          requests: bucket.requests,
          input: bucket.input,
          output: bucket.output,
          cacheRead: bucket.cacheRead,
          cacheWrite: bucket.cacheWrite,
          listUsd,
          amount,
          currency,
        });
        continue;
      }
      row.requests += bucket.requests;
      row.input += bucket.input;
      row.output += bucket.output;
      row.cacheRead += bucket.cacheRead;
      row.cacheWrite += bucket.cacheWrite;
      row.listUsd = row.listUsd === null || listUsd === null ? null : row.listUsd + listUsd;
      row.amount = row.amount === null || amount === null ? null : row.amount + amount;
    }
  }
  return {
    rows: [...rows.values()],
    unpricedModels: [...unpriced],
    sources: [...sources.values()],
  };
}

/**
 * Usage statistics: this computer's from its agents' session records, merged with what
 * the other computers saved here (Settings → Remote access) report of theirs.
 */
export function createUsageStatsService(deps: {
  scanner: UsageScanner;
  attribution: () => Promise<UsageAttribution>;
  /** models.dev's prices, as listed (prices set by hand are applied over them here). */
  catalog: () => Promise<PriceCatalog>;
  refreshCatalog?: () => Promise<void>;
  catalogFetchedAt?: () => number | null;
  listings?: (model: string) => Promise<ModelPrice[]>;
  pricingFile: string;
  machineName: () => string;
  remotes: () => Promise<UsageRemote[]>;
  fetch?: typeof fetch;
}) {
  const doFetch = deps.fetch ?? fetch;

  const readPricing = async (): Promise<UsagePricing> => {
    try {
      return usagePricingSchema.parse(JSON.parse(await readFile(deps.pricingFile, 'utf8')));
    } catch {
      return usagePricingSchema.parse({});
    }
  };

  const local = async (from: string, to: string) => {
    const [files, attribution, pricing, catalog] = await Promise.all([
      deps.scanner.scan(),
      deps.attribution(),
      readPricing(),
      deps.catalog(),
    ]);
    return buildRows({
      machine: deps.machineName(),
      files,
      from,
      to,
      attribution,
      pricing,
      catalog,
    });
  };

  const remote = async (target: UsageRemote, from: string, to: string): Promise<LocalUsage> => {
    const url = new URL('/usage-stats', target.baseUrl);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    const response = await doFetch(url, {
      headers: { cookie: `emdash_remote=${target.token}` },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (response.status === 404)
      throw new Error('Its Emdash is older: update it to merge its usage');
    if (response.status === 401) throw new Error('Signed out there: add the computer again');
    if (!response.ok) throw new Error(`It answered ${response.status}`);
    return (await response.json()) as LocalUsage;
  };

  return {
    /** This computer's rows, for its Remote access to answer another computer with. */
    async localUsage(from: string, to: string): Promise<LocalUsage> {
      const { rows, unpricedModels } = await local(from, to);
      return { machine: deps.machineName(), rows, unpricedModels };
    },

    async report(input: { from: string; to: string; allMachines: boolean }): Promise<UsageReport> {
      const own = await local(input.from, input.to);
      const machines: UsageReport['machines'] = [
        { name: deps.machineName(), local: true, error: null },
      ];
      const rows = [...own.rows];
      const unpriced = new Set(own.unpricedModels);
      if (input.allMachines) {
        const targets = await deps.remotes();
        const results = await Promise.allSettled(
          targets.map((target) => remote(target, input.from, input.to))
        );
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            machines.push({ name: result.value.machine, local: false, error: null });
            rows.push(...result.value.rows);
            for (const model of result.value.unpricedModels) unpriced.add(model);
          } else {
            const reason = result.reason as { name?: string; message?: string };
            machines.push({
              name: targets[index]?.name ?? '?',
              local: false,
              error:
                reason?.name === 'TimeoutError'
                  ? 'No answer in time (its first count reads all its history; try again soon)'
                  : (reason?.message ?? String(result.reason)),
            });
          }
        });
      }
      return { rows, machines, unpricedModels: [...unpriced] };
    },

    async pricing(): Promise<{ pricing: UsagePricing; sources: UsageSource[] }> {
      const today = new Date().toISOString().slice(0, 10);
      const { sources } = await local('0000-00-00', today);
      const attribution = await deps.attribution();
      // Configured providers not used yet can be priced ahead of their first call.
      for (const provider of attribution.providers) {
        if (sources.some((source) => source.key === provider.id)) continue;
        sources.push({
          key: provider.id,
          name: provider.name,
          defaultBilling: provider.account ? 'subscription' : 'usage',
        });
      }
      return { pricing: await readPricing(), sources };
    },

    async setPricing(pricing: UsagePricing): Promise<void> {
      await mkdir(path.dirname(deps.pricingFile), { recursive: true });
      await writeFile(deps.pricingFile, JSON.stringify(usagePricingSchema.parse(pricing), null, 2));
    },

    /** models.dev's prices with the ones set by hand over them, for every cost Emdash shows. */
    async pricedCatalog(): Promise<PriceCatalog> {
      const [catalog, pricing] = await Promise.all([deps.catalog(), readPricing()]);
      if (Object.keys(pricing.models).length === 0) return catalog;
      const priced = new Map(catalog);
      for (const [model, price] of Object.entries(pricing.models)) {
        const manual = { ...price, listing: 'manual' };
        priced.set(model, manual);
        priced.set(model.replace(/\[[^\]]*\]$/, '').replace(/:[a-z]+$/i, ''), manual);
      }
      return priced;
    },

    async prices(models: string[]) {
      const [catalog, pricing] = await Promise.all([deps.catalog(), readPricing()]);
      return {
        fetchedAt: deps.catalogFetchedAt?.() ?? null,
        models: models.map((model) => {
          const manual = pricing.models[model];
          return manual
            ? { model, price: { ...manual, listing: 'manual' }, manual: true }
            : { model, price: priceOf(catalog, model) ?? null, manual: false };
        }),
      };
    },

    async setModelPrice(model: string, price: ModelPriceValue | null): Promise<void> {
      const pricing = await readPricing();
      const models = { ...pricing.models };
      if (price) models[model] = { ...price, listing: 'manual' };
      else delete models[model];
      await mkdir(path.dirname(deps.pricingFile), { recursive: true });
      await writeFile(deps.pricingFile, JSON.stringify({ ...pricing, models }, null, 2));
    },

    async modelListings(model: string): Promise<ModelPrice[]> {
      return (await deps.listings?.(model)) ?? [];
    },

    async refreshPrices(): Promise<void> {
      await deps.refreshCatalog?.();
    },

    /** Reads the session records in the background, so the first report is quick. */
    warm(): void {
      void deps.scanner.scan().catch(() => undefined);
    },
  };
}

export type UsageStatsService = ReturnType<typeof createUsageStatsService>;
