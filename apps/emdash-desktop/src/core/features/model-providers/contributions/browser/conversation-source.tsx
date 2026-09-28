import { observer } from 'mobx-react-lite';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { isProviderCapableAgent } from '@core/features/model-providers/api';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { Conversation } from '@core/primitives/conversations/api';

/** Where a conversation's agent gets its model: a provider, or its own sign-in/config. */
export type ConversationSource =
  | { kind: 'provider'; name: string; model: string | null; isAgentDefault: boolean }
  | { kind: 'own'; isAgentDefault: boolean };

/**
 * The source a conversation runs on. "Agent default" conversations follow the agent's
 * default as it is now, which is what their next start or resume uses. Null for agents
 * that cannot run on a provider.
 */
export function useConversationSource(
  conversation: Conversation | undefined
): ConversationSource | null {
  const agentId = conversation?.providerId ?? '';
  const { value: settings } = useAppSettingsKey('modelProviders');
  const { value: agentConfig } = useAgentSettings(
    agentId,
    hostRefFromConnectionId(
      conversation ? getProjectSshConnectionId(conversation.projectId) : undefined
    )
  );
  if (!conversation || !isProviderCapableAgent(agentId)) return null;

  const isAgentDefault = conversation.modelSource === undefined;
  const sourceId = isAgentDefault ? agentConfig?.modelSource : conversation.modelSource;
  if (typeof sourceId !== 'string' || sourceId === '') return { kind: 'own', isAgentDefault };
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

/** Tab tooltip naming the conversation and the source it runs on. */
export function conversationSourceTooltip(
  label: string,
  source: ConversationSource | null
): string {
  if (!source) return label;
  if (source.kind === 'own') return `${label} — runs on the agent's own sign-in or configuration`;
  const model = source.model ?? 'default';
  return source.isAgentDefault
    ? `${label} — runs on the provider ${source.name} with the model ${model} (the agent default)`
    : `${label} — runs on the provider ${source.name} with the model ${model}`;
}

/** Muted provider name shown after a conversation's tab title; nothing on its own login. */
export const ConversationSourceSuffix = observer(function ConversationSourceSuffix({
  source,
}: {
  source: ConversationSource | null;
}) {
  if (source?.kind !== 'provider') return null;
  return (
    <span className="ml-1 text-xs text-foreground-muted">
      {source.name}
      {source.isAgentDefault ? <span translate="yes">(default)</span> : null}
    </span>
  );
});
