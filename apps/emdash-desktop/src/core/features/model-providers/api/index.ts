import { z } from 'zod';

/**
 * A model provider the user configured once and can route agents through: an
 * OpenAI/Anthropic-compatible gateway such as new-api. Its API key is never part of this
 * record; it lives in the encrypted secrets store under {@link modelProviderSecretKey}.
 */
export const modelProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Gateway root, e.g. `http://127.0.0.1:3000` (a trailing `/v1` is tolerated). */
  baseUrl: z.string().min(1),
  /** Model ids the gateway serves, as fetched from its `/v1/models`. */
  models: z.array(z.string()).default([]),
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const modelProvidersSettingsSchema = z
  .object({ providers: z.array(modelProviderSchema).default([]) })
  .default({ providers: [] });
export type ModelProvidersSettings = z.infer<typeof modelProvidersSettingsSchema>;

/**
 * Agents that can run on a configured provider instead of their own account/config.
 * Official subscription logins stay with each vendor's own CLI (Claude Code, Codex,
 * Cursor); they are never lent to other agents.
 */
export const PROVIDER_CAPABLE_AGENTS = ['claude', 'codex', 'opencode', 'pi', 'oh-my-pi'] as const;
export type ProviderCapableAgent = (typeof PROVIDER_CAPABLE_AGENTS)[number];

export function isProviderCapableAgent(agentId: string): agentId is ProviderCapableAgent {
  return (PROVIDER_CAPABLE_AGENTS as readonly string[]).includes(agentId);
}

/** What "no provider selected" means for an agent, for display. */
export function defaultSourceLabel(agentId: string): string {
  switch (agentId) {
    case 'claude':
      return 'Official login (Claude subscription)';
    case 'codex':
      return 'Official login (ChatGPT)';
    case 'cursor':
      return 'Official login (Cursor)';
    default:
      return "Agent's own configuration";
  }
}

export function modelProviderSecretKey(providerId: string): string {
  return `model-provider:${providerId}:api-key`;
}

function trimSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** OpenAI-compatible base, ending in `/v1`. */
export function openAiBaseUrl(baseUrl: string): string {
  const root = trimSlashes(baseUrl);
  return root.endsWith('/v1') ? root : `${root}/v1`;
}

/** Anthropic-compatible base: the root, since clients append `/v1/messages` themselves. */
export function anthropicBaseUrl(baseUrl: string): string {
  return trimSlashes(baseUrl).replace(/\/v1$/, '');
}

/** A config-safe id (no spaces, lowercase) for the provider inside agent configs. */
export function providerConfigId(provider: Pick<ModelProvider, 'id'>): string {
  return `emdash-${provider.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Provider key operations the main process exposes (implemented over the secrets store). */
export type ModelProviderKeys = {
  read(providerId: string): Promise<string | null>;
  hasKey(providerId: string): Promise<boolean>;
  set(providerId: string, apiKey: string): Promise<void>;
  clear(providerId: string): Promise<void>;
  listModels(input: { providerId: string; baseUrl: string; apiKey?: string }): Promise<string[]>;
};

/** A per-conversation source; `null` means the agent's own login/config. */
export type ModelSourceOverride = { modelSource: string | null; sourceModel?: string };

/** The conversation's own source choice, or undefined to use the agent's default. */
export function sourceOverrideOf(
  config: { modelSource?: string | null; sourceModel?: string } | null | undefined
): ModelSourceOverride | undefined {
  if (!config || config.modelSource === undefined) return undefined;
  return { modelSource: config.modelSource, sourceModel: config.sourceModel };
}

/** A conversation's source: absent = agent default, null = own login, id = that provider. */
export type ModelSourceValue = { modelSource?: string | null; sourceModel?: string };

/** True when a provider (rather than the agent's own login or default) is selected. */
export function usesProviderSource(value: ModelSourceValue): boolean {
  return typeof value.modelSource === 'string';
}

/** One subscription limit window, e.g. the rolling 5 hours or the week. */
export type UsageWindow = {
  label: string;
  usedPercent: number;
  /** When it resets, as the vendor phrased it or formatted from a timestamp. */
  resets: string | null;
};

export type AgentUsage = {
  agent: 'claude' | 'codex' | 'cursor';
  plan: string | null;
  windows: UsageWindow[];
  /** When the numbers were read (Codex: its last turn; Claude: the last /usage probe). */
  observedAt: number;
  /** Why no numbers are shown (not logged in, API-key billing, probe failed, …). */
  unavailable?: string;
  /** The vendor's own usage page, where numbers are not available locally (Cursor). */
  detailsUrl?: string;
};

export type UsageLimits = { agents: AgentUsage[] };

export type UsageLimitsService = {
  get(options?: { refresh?: boolean }): Promise<UsageLimits>;
};
