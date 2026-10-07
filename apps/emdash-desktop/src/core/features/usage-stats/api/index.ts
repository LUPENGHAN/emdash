import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Model calls and what they cost, read from the agents' own session records (Claude
 * Code, Codex, Pi, Oh My Pi) on every computer: no request passes through Emdash, but
 * each agent writes down every call's model and tokens.
 */
export const usageStatsDomain = 'usageStats' as const;

export const USAGE_CURRENCIES = ['USD', 'CNY'] as const;
export type UsageCurrency = (typeof USAGE_CURRENCIES)[number];

/** Pay per call (a gateway, an API key) or a flat subscription (the call costs nothing more). */
export const USAGE_BILLINGS = ['usage', 'subscription'] as const;
export type UsageBilling = (typeof USAGE_BILLINGS)[number];

/** One day's calls on one computer, by one agent, on one model, from one source, in one project. */
export const usageRowSchema = z.object({
  machine: z.string(),
  /** Local calendar day, YYYY-MM-DD. */
  day: z.string(),
  agent: z.string(),
  model: z.string(),
  /** A configured provider's id, or `own:<agent>[:<vendor>]` for the agent's own config. */
  source: z.string(),
  sourceName: z.string(),
  billing: z.enum(USAGE_BILLINGS),
  project: z.string(),
  requests: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** At the vendors' API list prices, in USD; null for a model without a known price. */
  listUsd: z.number().nullable(),
  /** What was charged, in `currency`: null on a subscription or for an unpriced model. */
  amount: z.number().nullable(),
  currency: z.enum(USAGE_CURRENCIES),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

export const usageReportSchema = z.object({
  rows: z.array(usageRowSchema),
  machines: z.array(
    z.object({ name: z.string(), local: z.boolean(), error: z.string().nullable() })
  ),
  unpricedModels: z.array(z.string()),
});
export type UsageReport = z.infer<typeof usageReportSchema>;

/** How one source bills: absent fields take the source's defaults. */
export const sourcePricingSchema = z.object({
  billing: z.enum(USAGE_BILLINGS).optional(),
  /** What is charged per unit of the official list price: 1 = list price, 0.5 = half. */
  multiplier: z.number().positive().optional(),
  /** The currency charged in: `multiplier` CNY per USD of list price, for CNY. */
  currency: z.enum(USAGE_CURRENCIES).optional(),
});
export type SourcePricing = z.infer<typeof sourcePricingSchema>;

export const usagePricingSchema = z.object({
  sources: z.record(z.string(), sourcePricingSchema).default({}),
  /** To show one total over both currencies. */
  usdToCny: z.number().positive().default(7.1),
});
export type UsagePricing = z.infer<typeof usagePricingSchema>;

/** A source seen in the records or configured, with its defaults, for editing its pricing. */
export const usageSourceSchema = z.object({
  key: z.string(),
  name: z.string(),
  defaultBilling: z.enum(USAGE_BILLINGS),
});
export type UsageSource = z.infer<typeof usageSourceSchema>;

export const usageStatsContract = defineContract({
  /** Calls between two local days (inclusive), on this computer and, if asked, the others. */
  report: procedure({
    input: z.object({ from: z.string(), to: z.string(), allMachines: z.boolean() }),
    output: usageReportSchema,
  }),
  pricing: procedure({
    input: z.void().optional(),
    output: z.object({ pricing: usagePricingSchema, sources: z.array(usageSourceSchema) }),
  }),
  setPricing: procedure({ input: usagePricingSchema, output: z.void() }),
});

/** What the usage statistics controller serves. */
export type UsageStatsService = {
  report(input: { from: string; to: string; allMachines: boolean }): Promise<UsageReport>;
  pricing(): Promise<{ pricing: UsagePricing; sources: UsageSource[] }>;
  setPricing(pricing: UsagePricing): Promise<void>;
};

/** The source key of an agent's own configuration. */
export function ownSourceKey(agent: string, vendor?: string | null): string {
  return vendor ? `own:${agent}:${vendor}` : `own:${agent}`;
}

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
};

export function agentDisplayName(agent: string): string {
  return AGENT_NAMES[agent] ?? agent;
}
