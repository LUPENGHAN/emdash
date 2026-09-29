import { z } from 'zod';

/** The wire protocols a provider can speak; each provider speaks one. */
export const PROVIDER_PROTOCOLS = ['anthropic', 'openai-chat', 'openai-responses'] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export const PROVIDER_PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
};

/**
 * A model provider the user configured once and can route agents through: any API that
 * speaks one of {@link PROVIDER_PROTOCOLS} (a vendor, a gateway such as new-api, …). Its
 * API key is never part of this record; it lives in the encrypted secrets store under
 * {@link modelProviderSecretKey}.
 */
export const modelProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Absent on providers saved before protocols: a new-api style gateway serving all three. */
  protocol: z.enum(PROVIDER_PROTOCOLS).optional(),
  /**
   * Anthropic: the root (clients add `/v1/messages`). OpenAI: the base, e.g. `…/v1`.
   * Empty for an official account.
   */
  baseUrl: z.string(),
  /**
   * Set when this is not an API but another sign-in of an agent's own vendor account:
   * the agent runs with its own login, kept in a config dir of its own for this account.
   */
  account: z.object({ agent: z.enum(['claude', 'codex']) }).optional(),
  /** Where to list the upstream models, when not the protocol's usual models endpoint. */
  modelsUrl: z.string().optional(),
  /** The models agents may use: the ones picked from the upstream list or typed in. */
  models: z.array(z.string()).default([]),
  /**
   * Context window in tokens, per model, where an agent would otherwise guess it.
   */
  contextWindows: z.record(z.string(), z.number().int().positive()).optional(),
  /** Which of the models Claude Code uses for what (Anthropic Messages providers). */
  claude: z
    .object({
      /** The model when the conversation or agent default names none. */
      model: z.string().optional(),
      opus: z.string().optional(),
      sonnet: z.string().optional(),
      haiku: z.string().optional(),
      fable: z.string().optional(),
      /** Subagents, agent-team teammates, and workflow agents not given a model. */
      subagent: z.string().optional(),
      /** How `/model` names each alias, instead of the raw model ID. */
      names: z
        .object({
          opus: z.string().optional(),
          sonnet: z.string().optional(),
          haiku: z.string().optional(),
          fable: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ClaudeModelRoles = NonNullable<ModelProvider['claude']>;

/** Claude Code's model aliases, each pointable at one of a provider's models. */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

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

/** Agents that can sign in with more than one of their vendor's accounts. */
export const OFFICIAL_ACCOUNT_AGENTS = ['claude', 'codex'] as const;
export type OfficialAccountAgent = (typeof OFFICIAL_ACCOUNT_AGENTS)[number];

export const OFFICIAL_ACCOUNT_LABELS: Record<OfficialAccountAgent, string> = {
  claude: 'Claude subscription',
  codex: 'ChatGPT',
};

export type OfficialAccount = ModelProvider & { account: { agent: OfficialAccountAgent } };

export function isOfficialAccount(provider: ModelProvider): provider is OfficialAccount {
  return provider.account !== undefined;
}

/**
 * The sources an agent can pick from: every API provider (some may not suit it; see
 * {@link providerSupportsAgent}), and only its own vendor's accounts.
 */
export function sourcesForAgent(providers: ModelProvider[], agentId: string): ModelProvider[] {
  return providers.filter((provider) => !provider.account || provider.account.agent === agentId);
}

/** Whether an official account is signed in, and as whom. */
export type OfficialAccountStatus = {
  signedIn: boolean;
  email: string | null;
  plan: string | null;
};

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

/** An OpenAI base as typed: bare hosts get `/v1`, any other path is kept (GLM's `/api/paas/v4`). */
function openAiBaseAsTyped(baseUrl: string): string {
  const trimmed = trimSlashes(baseUrl);
  try {
    return new URL(trimmed).pathname.replace(/\/+$/, '') === '' ? `${trimmed}/v1` : trimmed;
  } catch {
    return trimmed;
  }
}

export type ProviderEndpoints = {
  anthropic?: { url: string; auth: 'bearer' | 'api-key' };
  openai?: { url: string; api: 'chat' | 'responses' | 'both' };
};

/** The APIs a provider speaks, with normalized URLs. */
export function providerEndpoints(
  provider: Pick<ModelProvider, 'protocol' | 'baseUrl'> & Partial<Pick<ModelProvider, 'account'>>
): ProviderEndpoints {
  if ('account' in provider && provider.account) return {};
  const base = provider.baseUrl;
  switch (provider.protocol) {
    case undefined:
      return {
        anthropic: { url: anthropicBaseUrl(base), auth: 'bearer' },
        openai: { url: openAiBaseUrl(base), api: 'both' },
      };
    case 'anthropic': {
      const url = anthropicBaseUrl(base);
      // Anthropic's own API takes x-api-key; compatible vendors take a bearer token.
      const official = /^https?:\/\/api\.anthropic\.com(\/|$)/.test(url);
      return { anthropic: { url, auth: official ? 'api-key' : 'bearer' } };
    }
    case 'openai-chat':
      return { openai: { url: openAiBaseAsTyped(base), api: 'chat' } };
    case 'openai-responses':
      return { openai: { url: openAiBaseAsTyped(base), api: 'responses' } };
  }
}

/** The upstream models list: the provider's own URL, else the protocol's usual one. */
export function providerModelsUrl(
  provider: Pick<ModelProvider, 'protocol' | 'baseUrl' | 'modelsUrl'>
): string {
  if (provider.modelsUrl?.trim()) return provider.modelsUrl.trim();
  const { openai, anthropic } = providerEndpoints(provider);
  return openai ? `${openai.url}/models` : `${anthropic!.url}/v1/models`;
}

/** How the models request sends the key. */
export function providerModelsAuth(
  provider: Pick<ModelProvider, 'protocol' | 'baseUrl'>
): 'bearer' | 'anthropic-bearer' | 'anthropic-api-key' {
  if (provider.protocol !== 'anthropic') return 'bearer';
  return providerEndpoints(provider).anthropic?.auth === 'api-key'
    ? 'anthropic-api-key'
    : 'anthropic-bearer';
}

/** Whether an agent can run on a provider, and if not, why (for the pickers). */
export function providerSupportsAgent(
  provider: ModelProvider,
  agentId: string
): { ok: true } | { ok: false; reason: string } {
  if (provider.account) {
    return provider.account.agent === agentId
      ? { ok: true }
      : { ok: false, reason: `a ${OFFICIAL_ACCOUNT_LABELS[provider.account.agent]} account` };
  }
  const endpoints = providerEndpoints(provider);
  switch (agentId) {
    case 'claude':
      return endpoints.anthropic ? { ok: true } : { ok: false, reason: 'needs Anthropic Messages' };
    case 'codex':
      return endpoints.openai && endpoints.openai.api !== 'chat'
        ? { ok: true }
        : { ok: false, reason: 'needs OpenAI Responses' };
    default:
      return { ok: true };
  }
}

/** One line describing a provider's protocol and URL, for lists. */
export function describeProvider(provider: ModelProvider): string {
  if (provider.account) return `${OFFICIAL_ACCOUNT_LABELS[provider.account.agent]} account`;
  const protocol = provider.protocol
    ? PROVIDER_PROTOCOL_LABELS[provider.protocol]
    : 'Gateway (all protocols)';
  return `${protocol} · ${provider.baseUrl}`;
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
  listModels(input: {
    providerId: string;
    url: string;
    /** How to send the key: Anthropic-style headers or an OpenAI bearer token. */
    auth: 'bearer' | 'anthropic-bearer' | 'anthropic-api-key';
    apiKey?: string;
  }): Promise<string[]>;
};

/** Ends every "the chosen provider cannot be used" launch error; also how the UI spots one. */
export const MODEL_SOURCE_UNAVAILABLE_HINT =
  'Pick another source with “Restart with another provider…” in the conversation’s tab menu, or under Settings → Providers.';

/** The message of a launch refused because its provider cannot be used, if that is the error. */
export function modelSourceUnavailableMessage(error: unknown): string | null {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return message.includes(MODEL_SOURCE_UNAVAILABLE_HINT) ? message : null;
}

/** A per-conversation source; `null` means the agent's own login/config. */
/**
 * Where an agent on its own configuration gets its model: its vendor's sign-in
 * (`official`), or the third-party provider its config names.
 */
export type OwnSource = { official: boolean; provider: string | null; model: string | null };

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

/** A context window as typed: `1000000`, `1m`, `256k`, `1.5M`. Null when not a size. */
export function parseContextWindow(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim());
  if (!match) return null;
  const scale = match[2] ? { k: 1_000, m: 1_000_000 }[match[2].toLowerCase() as 'k' | 'm'] : 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return tokens > 0 ? tokens : null;
}

/** A context window for display, the way people write them: `1m`, `256k`, `131072`. */
export function formatContextWindow(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}
