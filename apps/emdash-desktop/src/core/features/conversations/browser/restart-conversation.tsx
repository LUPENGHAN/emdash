import { Dialog, Field, Input, Select, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getAgentsClient, hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  isProviderCapableAgent,
  usesProviderSource,
  type ModelSourceValue,
} from '@core/features/model-providers/api';
import { ModelSourceSelect } from '@core/features/model-providers/contributions/browser/model-source-select';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { openModal, useModalController } from '@core/manifests/browser/modal-api';
import type { Conversation } from '@core/primitives/conversations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { log } from '@core/primitives/logging/browser/logger';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { agentDisplayName } from './handoff';

/** Providers whose CLI and chat adapter resume a session by id. */
const RESUMABLE_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'pi', 'oh-my-pi']);

/**
 * The session a restart can resume: chat (ACP) ids are always the provider's own; a
 * terminal's is once captured, and Claude's placeholder is real (it is spawned with
 * `--session-id <conversation id>`). Null means the restart starts a new session.
 */
export function resumableSessionId(conversation: Conversation): string | null {
  const sessionId = conversation.sessionId;
  if (!sessionId || !RESUMABLE_PROVIDERS.has(conversation.providerId)) return null;
  if (conversation.type === 'acp' || conversation.providerId === 'claude') return sessionId;
  return sessionId !== conversation.id ? sessionId : null;
}

/**
 * The conversation as the backend has it now: the window's copy is not told when the
 * runtime later records the session id, so a restart reads it fresh.
 */
async function latestConversation(conversation: Conversation): Promise<Conversation> {
  const conversations = await (
    await getConversationsClient()
  ).getConversationsForTask({ projectId: conversation.projectId, taskId: conversation.taskId });
  return conversations.find((candidate) => candidate.id === conversation.id) ?? conversation;
}

export type RestartChoice = ModelSourceValue & { model?: string };

/** Why the agent could not start on this choice, or null; asked before anything stops. */
async function sourceProblem(providerId: string, choice: ModelSourceValue): Promise<string | null> {
  const { error } = await (
    await getAgentsClient()
  ).checkModelSource({
    agentId: providerId,
    ...(choice.modelSource !== undefined && {
      modelSource: choice.modelSource,
      sourceModel: choice.sourceModel,
    }),
  });
  return error;
}

/**
 * Restarts a conversation's agent on another source (provider and model): the current
 * conversation is removed first (killing its agent, so two processes never write one
 * session), then a new one of the same UI resumes the same session with the new source.
 * Provider session files are untouched, so a failure leaves it resumable from History.
 */
export async function restartConversation(
  current: Conversation,
  choice: RestartChoice
): Promise<Conversation> {
  const conversation = await latestConversation(current);
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  // The old conversation goes first, so a source that cannot start must stop us here.
  const problem = await sourceProblem(conversation.providerId, choice);
  if (problem) throw new Error(problem);
  const sessionId = resumableSessionId(conversation);
  await manager.deleteConversation(conversation.id);
  return manager.createConversation({
    id: crypto.randomUUID(),
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: conversation.providerId,
    title: conversation.title,
    type: conversation.type ?? 'pty',
    autoApprove: conversation.autoApprove,
    options: conversation.options,
    isInitialConversation: conversation.isInitialConversation ?? undefined,
    ...(sessionId && { providerSessionId: sessionId }),
    ...(choice.modelSource !== undefined && { modelSource: choice.modelSource }),
    ...(choice.sourceModel && { sourceModel: choice.sourceModel }),
    ...(!usesProviderSource(choice) && choice.model && { model: choice.model }),
  });
}

const RestartConversationModal = observer(function RestartConversationModal({
  conversation,
}: {
  conversation: Conversation;
}) {
  const { complete } = useModalController('restartConversationModal');
  const [source, setSource] = useState<ModelSourceValue>(() =>
    conversation.modelSource !== undefined
      ? { modelSource: conversation.modelSource, sourceModel: conversation.sourceModel }
      : {}
  );
  const [model, setModel] = useState(conversation.model ?? '');
  const [busy, setBusy] = useState(false);
  useCloseGuard(busy);
  const connectionId = getProjectSshConnectionId(conversation.projectId);
  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const models = agents?.find((agent) => agent.id === conversation.providerId)?.capabilities.models;
  const modelOptions = models?.kind === 'selectable' ? models.modelOptions : null;
  const { data: latest } = useQuery({
    queryKey: ['restartConversation', conversation.id],
    gcTime: 0,
    queryFn: () => latestConversation(conversation),
  });
  const resumes = resumableSessionId(latest ?? conversation) !== null;
  const { data: problem } = useQuery({
    queryKey: ['restartConversation', 'source', conversation.providerId, source],
    gcTime: 0,
    queryFn: () => sourceProblem(conversation.providerId, source),
  });
  const isTerminal = (conversation.type ?? 'pty') === 'pty';

  const restart = async () => {
    setBusy(true);
    try {
      const created = await restartConversation(conversation, {
        ...source,
        model: model.trim() || undefined,
      });
      complete({ conversationId: created.id });
    } catch (error) {
      log.error('restart conversation failed', error);
      toast.error(`Could not restart: ${error instanceof Error ? error.message : String(error)}`);
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Restart {agentDisplayName(conversation.providerId)}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <p className="text-xs text-foreground-muted">
            {resumes
              ? 'The agent stops and the same session continues on the source below. A reply in progress is cut off.'
              : 'This conversation has no session to resume yet, so a new one starts on the source below.'}
          </p>
          <ModelSourceSelect
            agentId={conversation.providerId}
            value={source}
            onChange={setSource}
          />
          {!usesProviderSource(source) && (modelOptions || isTerminal) ? (
            <Field.Root>
              <Field.Label>Model</Field.Label>
              {modelOptions && Object.keys(modelOptions).length > 0 ? (
                <Select.Root
                  value={model}
                  onValueChange={(next) => setModel(next ? String(next) : '')}
                >
                  <Select.Trigger appearance="input" className="w-full">
                    <Select.Value>
                      {model ? (modelOptions[model]?.name ?? model) : 'Default model'}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Content align="start" width="trigger">
                    <Select.Item value="">Default model</Select.Item>
                    {model && !modelOptions[model] ? (
                      <Select.Item value={model}>{model}</Select.Item>
                    ) : null}
                    {Object.entries(modelOptions).map(([id, option]) => (
                      <Select.Item key={id} value={id}>
                        {option.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              ) : (
                <Input
                  value={model}
                  placeholder="Default model"
                  onChange={(event) => setModel(event.target.value)}
                />
              )}
            </Field.Root>
          ) : null}
          {problem ? <p className="text-destructive text-xs">{problem}</p> : null}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <ConfirmButton
          variant="primary"
          disabled={busy || problem === undefined || problem !== null}
          onClick={() => void restart()}
        >
          {busy ? 'Restarting…' : 'Restart'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const restartConversationModal = defineModal<{ conversationId: string }>()({
  id: 'restartConversationModal',
  component: RestartConversationModal,
});

/** Tab-menu command: restart the agent on another provider or model. */
export function restartConversationCommands(conversation: Conversation | undefined) {
  if (!conversation || !isProviderCapableAgent(conversation.providerId)) return [];
  return [
    {
      id: 'conversation:restart-source',
      label: 'Restart with another provider…',
      group: 'handoff',
      run: () => {
        void (async () => {
          const outcome = await openModal('restartConversationModal', { conversation });
          if (!outcome.success) return;
          getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
            (conversation.type ?? 'pty') === 'acp' ? 'acp-chat' : 'conversation',
            { conversationId: outcome.data.conversationId },
            { preview: false }
          );
        })().catch((error: unknown) => {
          log.error('restart conversation failed', error);
          toast.error(`Could not restart: ${String(error)}`);
        });
      },
    },
  ];
}
