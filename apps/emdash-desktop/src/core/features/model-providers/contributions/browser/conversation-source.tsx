import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { getAgentsClient, hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { isProviderCapableAgent } from '@core/features/model-providers/api';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { Conversation } from '@core/primitives/conversations/api';

/**
 * Where a conversation's agent gets its model: an Emdash provider, or the agent's own
 * setup — its vendor's sign-in (`official`) or a provider its own config names.
 * `isAgentDefault` marks conversations following the agent's default source.
 */
export type ConversationSource =
  | { kind: 'provider'; name: string; model: string | null; isAgentDefault: boolean }
  | {
      kind: 'own';
      official: boolean;
      provider: string | null;
      model: string | null;
      isAgentDefault: boolean;
    };

const OFFICIAL_LABELS: Record<string, string> = {
  claude: 'Claude subscription',
  codex: 'ChatGPT login',
  cursor: 'Cursor login',
};

/**
 * The source a conversation runs on. "Agent default" conversations follow the agent's
 * default as it is now, which is what their next start or resume uses. `modelId` is the
 * model the conversation has picked, when the UI knows it (a chat's live model).
 */
export function useConversationSource(
  conversation: Conversation | undefined,
  modelId?: string
): ConversationSource | null {
  const agentId = conversation?.providerId ?? '';
  const connectionId = conversation ? getProjectSshConnectionId(conversation.projectId) : undefined;
  const { value: settings } = useAppSettingsKey('modelProviders');
  const { value: agentConfig } = useAgentSettings(agentId, hostRefFromConnectionId(connectionId));
  const capable = isProviderCapableAgent(agentId);
  const isAgentDefault = capable && conversation?.modelSource === undefined;
  const sourceId = !capable
    ? null
    : isAgentDefault
      ? agentConfig?.modelSource
      : conversation?.modelSource;
  const onProvider = typeof sourceId === 'string' && sourceId !== '';
  const ownModel = modelId ?? conversation?.model ?? undefined;
  // Agent configs are read on this computer, so a remote host's agent stays undescribed.
  const { data: own } = useQuery({
    queryKey: ['describeOwnSource', agentId, ownModel ?? null],
    enabled: Boolean(conversation) && !onProvider && !connectionId,
    staleTime: 30_000,
    queryFn: async () =>
      (await getAgentsClient()).describeOwnSource({
        agentId,
        ...(ownModel && { modelId: ownModel }),
      }),
  });

  if (!conversation) return null;
  if (onProvider) {
    const provider = settings?.providers.find((candidate) => candidate.id === sourceId);
    const chosenModel = isAgentDefault ? agentConfig?.sourceModel : conversation.sourceModel;
    return {
      kind: 'provider',
      name: provider?.name ?? 'Missing provider',
      // No model picked runs on the provider's first one (see effectiveAgentConfig).
      model: chosenModel || provider?.models[0] || null,
      isAgentDefault,
    };
  }
  if (!own) return null;
  return { kind: 'own', ...own, isAgentDefault };
}

/** Tab tooltip naming the conversation and the source it runs on. */
export function conversationSourceTooltip(
  label: string,
  source: ConversationSource | null
): string {
  if (!source) return label;
  if (source.kind === 'own') {
    if (source.official) {
      return source.isAgentDefault
        ? `${label} — runs on its official sign-in (the agent default)`
        : `${label} — runs on its official sign-in`;
    }
    if (!source.provider) return `${label} — runs on the agent's own sign-in or configuration`;
    return `${label} — runs on the provider ${source.provider} with the model ${source.model ?? 'default'}, set in the agent's own configuration`;
  }
  const model = source.model ?? 'default';
  return source.isAgentDefault
    ? `${label} — runs on the provider ${source.name} with the model ${model} (the agent default)`
    : `${label} — runs on the provider ${source.name} with the model ${model}`;
}

/** Muted source name shown after a conversation's tab title. */
export const ConversationSourceSuffix = observer(function ConversationSourceSuffix({
  agentId,
  source,
}: {
  agentId: string;
  source: ConversationSource | null;
}) {
  if (!source) return null;
  // Provider names are names; the official and fallback labels are interface text.
  const name =
    source.kind === 'provider' ? (
      source.name
    ) : source.official ? (
      <span translate="yes">{OFFICIAL_LABELS[agentId] ?? 'Official login'}</span>
    ) : (
      (source.provider ?? <span translate="yes">Own configuration</span>)
    );
  return (
    <span className="ml-1 text-xs text-foreground-muted">
      {name}
      {source.isAgentDefault ? <span translate="yes">(default)</span> : null}
    </span>
  );
});
