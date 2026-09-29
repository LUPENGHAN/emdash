import {
  hostDependencyErrorSchema,
  hostDependencySelectionSchema,
  resolvedHostDependencySchema,
} from '@emdash/core/primitives/host-dependencies/api';
import { hostRefSchema } from '@emdash/core/primitives/host/api';
import {
  agentConfigAuthErrorSchema,
  agentConfigContract,
  agentConfigListSchema,
  hooksStatusSchema,
} from '@emdash/core/runtimes/agent-config/api';
// The auth capability module directly: the plugins barrel drags in the plugin
// host and its node-only dependencies, which this isomorphic contract must not.
import { agentAuthStatusSchema } from '@emdash/core/services/agent-plugins/api/plugins/capabilities/auth';
import { hostDependencyOperationProgressSchema } from '@emdash/core/services/host-dependencies/api';
import { runtimeResolveErrorSchema } from '@emdash/core/services/runtime-broker/api';
import type { Result } from '@emdash/shared';
import {
  defineContract,
  fallible,
  liveJob,
  liveLog,
  liveModel,
  liveState,
  procedure,
} from '@emdash/wire/rpc';
import { z } from 'zod';
import type { UsageLimits } from '@core/features/model-providers/api';
import type {
  AgentInstallationStatus,
  AgentInstallError,
  AgentMetadata,
  AgentPayload,
  AgentSettings,
  AgentUninstallError,
  AgentUpdateError,
  InstallMethod,
} from '@core/primitives/agents/api';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';

const hostInputSchema = z.object({ host: hostRefSchema });
const agentInputSchema = hostInputSchema.extend({ id: z.string() });
const providerInputSchema = hostInputSchema.extend({ providerId: z.string() });
const agentsAuthErrorSchema = z.union([agentConfigAuthErrorSchema, runtimeResolveErrorSchema]);

export const agentsDomain = 'agents' as const;

export const agentsContract = defineContract({
  // Static plugin-registry metadata (icons, display names); identical on every host.
  listMetadata: procedure({ input: z.void(), output: z.custom<AgentMetadata[]>() }),
  list: fallible({
    input: hostInputSchema,
    data: z.custom<AgentPayload[]>(),
    error: runtimeResolveErrorSchema,
  }),
  get: fallible({
    input: agentInputSchema,
    data: z.custom<AgentPayload | null>(),
    error: runtimeResolveErrorSchema,
  }),
  listAgentInstallationStatus: fallible({
    input: hostInputSchema,
    data: z.custom<AgentInstallationStatus[]>(),
    error: runtimeResolveErrorSchema,
  }),
  install: liveJob({
    input: agentInputSchema.extend({
      method: z.custom<InstallMethod>().optional(),
      elevate: z.boolean().optional(),
    }),
    progress: hostDependencyOperationProgressSchema,
    result: z.custom<AgentInstallationStatus>(),
    error: z.union([z.custom<AgentInstallError>(), runtimeResolveErrorSchema]),
  }),
  update: liveJob({
    input: agentInputSchema.extend({
      method: z.custom<InstallMethod>().optional(),
      elevate: z.boolean().optional(),
    }),
    progress: hostDependencyOperationProgressSchema,
    result: z.custom<AgentInstallationStatus>(),
    error: z.union([z.custom<AgentUpdateError>(), runtimeResolveErrorSchema]),
  }),
  uninstall: fallible({
    input: agentInputSchema.extend({ method: z.custom<InstallMethod>().optional() }),
    data: z.custom<Result<AgentInstallationStatus, AgentUninstallError>>(),
    error: runtimeResolveErrorSchema,
  }),
  getDefaultSettings: fallible({
    input: agentInputSchema,
    data: z.custom<ProviderCustomConfig>(),
    error: runtimeResolveErrorSchema,
  }),
  getSettings: fallible({
    input: agentInputSchema,
    data: z.custom<AgentSettings>(),
    error: runtimeResolveErrorSchema,
  }),
  updateSettings: fallible({
    input: agentInputSchema.extend({ config: z.custom<Partial<ProviderCustomConfig>>() }),
    data: z.void(),
    error: runtimeResolveErrorSchema,
  }),
  setUsedInstallation: fallible({
    input: agentInputSchema.extend({ selection: hostDependencySelectionSchema }),
    data: z.void(),
    error: z.union([hostDependencyErrorSchema, runtimeResolveErrorSchema]),
  }),
  resolveInstallation: fallible({
    input: agentInputSchema.extend({ selection: hostDependencySelectionSchema.optional() }),
    data: resolvedHostDependencySchema,
    error: z.union([hostDependencyErrorSchema, runtimeResolveErrorSchema]),
  }),
  refreshLatestVersion: fallible({
    input: agentInputSchema,
    data: z.void(),
    error: runtimeResolveErrorSchema,
  }),
  probeAll: fallible({
    input: hostInputSchema,
    data: z.void(),
    error: runtimeResolveErrorSchema,
  }),

  auth: liveModel({
    key: hostInputSchema,
    states: {
      list: liveState({ data: agentConfigListSchema }),
    },
  }),
  hooksStatus: fallible({
    input: agentConfigContract.hooksStatus.input.extend(hostInputSchema.shape),
    data: hooksStatusSchema,
    error: runtimeResolveErrorSchema,
  }),
  startLogin: fallible({
    input: agentConfigContract.startLogin.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: agentsAuthErrorSchema,
  }),
  cancelLogin: fallible({
    input: providerInputSchema,
    data: z.void(),
    error: agentsAuthErrorSchema,
  }),
  sendLoginInput: fallible({
    input: agentConfigContract.sendLoginInput.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: agentsAuthErrorSchema,
  }),
  resizeLogin: fallible({
    input: agentConfigContract.resizeLogin.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: agentsAuthErrorSchema,
  }),
  markUrlHandled: fallible({
    input: agentConfigContract.markUrlHandled.input.extend(hostInputSchema.shape),
    data: z.void(),
    error: agentsAuthErrorSchema,
  }),
  refreshAuthStatus: fallible({
    input: providerInputSchema,
    data: agentAuthStatusSchema,
    error: agentsAuthErrorSchema,
  }),
  loginOutput: liveLog({
    key: providerInputSchema,
  }),
  // Model provider API keys (encrypted store). Keys can be set, cleared and checked from
  // the renderer, never read back.
  modelProviderKeyStatus: procedure({
    input: z.object({ providerId: z.string() }),
    output: z.object({ hasKey: z.boolean() }),
  }),
  setModelProviderKey: procedure({
    input: z.object({ providerId: z.string(), apiKey: z.string().min(1) }),
    output: z.void(),
  }),
  clearModelProviderKey: procedure({
    input: z.object({ providerId: z.string() }),
    output: z.void(),
  }),
  /** The provider's upstream model ids (GET its models URL); doubles as a connection test. */
  listModelProviderModels: fallible({
    input: z.object({
      providerId: z.string(),
      url: z.string(),
      auth: z.enum(['bearer', 'anthropic-bearer', 'anthropic-api-key']),
      apiKey: z.string().optional(),
    }),
    data: z.array(z.string()),
    error: z.object({ message: z.string() }),
  }),
  /**
   * Why an agent could not start on a source (a conversation's own, or the agent default
   * when `modelSource` is absent), or null when it can. Starts nothing.
   */
  checkModelSource: procedure({
    input: z.object({
      agentId: z.string(),
      modelSource: z.string().nullable().optional(),
      sourceModel: z.string().optional(),
    }),
    output: z.object({ error: z.string().nullable() }),
  }),
  /**
   * For an agent running on its own configuration: whether that is its vendor's sign-in
   * or which provider its config names. `modelId` is a model the conversation picked.
   */
  /** Whether an official account (a provider with `account`) is signed in, and as whom. */
  officialAccountStatus: procedure({
    input: z.object({ providerId: z.string() }),
    output: z.object({
      signedIn: z.boolean(),
      email: z.string().nullable(),
      plan: z.string().nullable(),
    }),
  }),
  /** Opens the agent's own sign-in for an official account (a Terminal window on macOS). */
  openOfficialAccountLogin: procedure({
    input: z.object({ providerId: z.string() }),
    output: z.object({ opened: z.boolean(), command: z.string() }),
  }),
  describeOwnSource: procedure({
    input: z.object({ agentId: z.string(), modelId: z.string().optional() }),
    output: z
      .object({
        official: z.boolean(),
        provider: z.string().nullable(),
        model: z.string().nullable(),
      })
      .nullable(),
  }),
  /** Subscription limit usage (5h / weekly) for agents that expose it. */
  getUsageLimits: procedure({
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.custom<UsageLimits>(),
  }),
});

export type AgentsContract = typeof agentsContract;
