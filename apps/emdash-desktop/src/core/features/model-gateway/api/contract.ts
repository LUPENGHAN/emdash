import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { ModelProvider } from '@core/features/model-providers/api';
import { gatewayModelSchema, type GatewayModel } from './model-catalog';

export type GatewayAccount = {
  id: string;
  name: string;
  provider: string;
  protocol?: 'anthropic' | 'openai-chat' | 'openai-responses' | 'all';
  models: string[];
  contextWindows?: Record<string, number>;
  disabled: boolean;
};
export type GatewayUsage = {
  requestedModel?: string;
  upstreamModel?: string;
  inboundProtocol?: string;
  upstreamProtocol?: string;
  routeRevision?: number;
  id: string;
  accountId: string;
  model: string;
  sessionId: string;
  at: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  failed: boolean;
  status: 'complete' | 'missing';
};
export type GatewayStatus = {
  models?: GatewayModel[];
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  error?: string;
  providers: ModelProvider[];
  accountTypes?: Record<string, string>;
  usageError?: string;
};
export const gatewaySourcePrefix = 'gateway:';
export const modelGatewayDomain = 'modelGateway' as const;
const empty = z.void();
export const modelGatewayContract = defineContract({
  status: procedure({ input: empty, output: z.custom<GatewayStatus>() }),
  migrationPreview: procedure({ input: empty, output: z.array(gatewayModelSchema) }),
  testModel: procedure({
    input: z.object({ alias: z.string().min(1), agent: z.enum(['claude', 'codex']) }),
    output: z.object({ ok: z.boolean(), status: z.number() }),
  }),
  saveModels: procedure({
    input: z.object({ models: z.array(gatewayModelSchema) }),
    output: empty,
  }),
  start: procedure({ input: empty, output: z.custom<GatewayStatus>() }),
  stop: procedure({ input: empty, output: empty }),
  usage: procedure({
    input: z.object({ limit: z.number().int().min(1).max(1000).default(100) }),
    output: z.custom<GatewayUsage[]>(),
  }),
  routes: procedure({
    input: empty,
    output: z.array(
      z.object({
        conversationId: z.string(),
        title: z.string(),
        sourceId: z.string(),
        providerName: z.string(),
        model: z.string(),
        requestedModel: z.string().optional(),
        upstreamModel: z.string().optional(),
        inboundProtocol: z.string().optional(),
        upstreamProtocol: z.string().optional(),
        revision: z.number().optional(),
        pendingName: z.string().optional(),
        restartReason: z.string().optional(),
      })
    ),
  }),
  beginOAuth: procedure({
    input: z.object({ provider: z.enum(['codex', 'claude']) }),
    output: z.object({ url: z.string(), state: z.string() }),
  }),
  oauthStatus: procedure({
    input: z.object({ state: z.string().min(1) }),
    output: z.object({ status: z.enum(['ok', 'wait', 'error']), error: z.string().optional() }),
  }),
  completeOAuth: procedure({
    input: z.object({
      provider: z.enum(['codex', 'claude']),
      redirectUrl: z.string().min(1).max(16384),
    }),
    output: empty,
  }),
  removeAccount: procedure({ input: z.object({ id: z.string().min(1) }), output: empty }),
  route: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.custom<{
      sourceId: string;
      model: string;
      launchConfiguration?: string;
      pending?: { sourceId: string; model: string };
      restartReason?: string;
      requiresNewSession?: boolean;
    } | null>(),
  }),
  switchRoute: procedure({
    input: z.object({
      conversationId: z.string().min(1),
      sourceId: z.string().startsWith(gatewaySourcePrefix),
      model: z.string().min(1),
    }),
    output: empty,
  }),
});
