import { Dialog, Field, Input, Select, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getAgentsClient, hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getModelGatewayClient } from '@core/features/model-gateway/api/browser/client';
import { catalogProvider, catalogSourceId } from '@core/features/model-gateway/api/model-catalog';
import {
  isProviderCapableAgent,
  usesProviderSource,
  type ModelSourceValue,
} from '@core/features/model-providers/api';
import { ModelSourceSelect } from '@core/features/model-providers/contributions/browser/model-source-select';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { openModal, useModalController } from '@core/manifests/browser/modal-api';
import type { Conversation, ConversationType } from '@core/primitives/conversations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { log } from '@core/primitives/logging/browser/logger';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { agentDisplayName } from './handoff';

/** Providers whose CLI and chat adapter resume a session by id. */
const RESUMABLE_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'pi', 'oh-my-pi', 'cursor']);
/** Terminals spawned under their conversation id (`--session-id`, `--resume <id>`). */
const CHOSEN_ID_PROVIDERS = new Set(['claude', 'cursor']);

/**
 * The session a restart can resume: chat (ACP) ids are always the provider's own; a
 * terminal's is once captured, and Claude's and Cursor's placeholder is real (they are
 * spawned under the conversation id). Null means the restart starts a new session.
 */
export function resumableSessionId(conversation: Conversation): string | null {
  const sessionId = conversation.sessionId;
  if (!sessionId || !RESUMABLE_PROVIDERS.has(conversation.providerId)) return null;
  if (conversation.type === 'acp' || CHOSEN_ID_PROVIDERS.has(conversation.providerId)) {
    return sessionId;
  }
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

/** The source a conversation runs on now, to restart it unchanged. */
export function currentChoice(conversation: Conversation): RestartChoice {
  return {
    ...(conversation.modelSource !== undefined && {
      modelSource: conversation.modelSource,
      sourceModel: conversation.sourceModel,
    }),
    ...(conversation.model && { model: conversation.model }),
  };
}

/**
 * Validate the replacement, stop the agent, then create its replacement before removing
 * the original record. A failed start leaves that record and its session recoverable.
 * Provider-bound state changes start a new session; requireSession refuses those changes.
 */
export async function restartConversation(
  current: Conversation,
  choice: RestartChoice,
  { type, requireSession = false }: { type?: ConversationType; requireSession?: boolean } = {}
): Promise<Conversation> {
  const conversation = await latestConversation(current);
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const codexIdentityChange =
    conversation.providerId === 'codex' && conversation.modelSource !== choice.modelSource;
  const problem = await sourceProblem(conversation.providerId, choice);
  if (problem) throw new Error(problem);
  const savedGatewayRoute = conversation.modelSource?.startsWith('gateway:')
    ? await (await getModelGatewayClient()).route({ conversationId: conversation.id })
    : null;
  const needsNewSession = Boolean(
    codexIdentityChange ||
    savedGatewayRoute?.requiresNewSession ||
    (choice.modelSource === catalogSourceId && conversation.modelSource !== catalogSourceId) ||
    (conversation.modelSource === catalogSourceId &&
      (choice.modelSource !== catalogSourceId || choice.sourceModel !== savedGatewayRoute?.model))
  );
  if (
    conversation.modelSource?.startsWith('gateway:') &&
    choice.modelSource?.startsWith('gateway:') &&
    (!type || type === conversation.type)
  ) {
    const client = await getModelGatewayClient();
    const route = await client.route({ conversationId: conversation.id });
    const status = await client.status();
    const catalog = catalogProvider(status.models ?? [], conversation.providerId);
    if (choice.modelSource === catalogSourceId) status.providers.push(catalog);
    const model =
      choice.sourceModel || status.providers.find((p) => p.id === choice.modelSource)?.models[0];
    if (
      choice.modelSource === catalogSourceId &&
      route?.sourceId === catalogSourceId &&
      !route.restartReason &&
      model === route.model
    )
      return conversation;
    const currentProvider = status.providers.find((p) => p.id === route?.sourceId);
    const nextProvider = status.providers.find((p) => p.id === choice.modelSource);
    const sameContext =
      model && currentProvider?.contextWindows?.[model] === nextProvider?.contextWindows?.[model];
    if (
      route &&
      !route.restartReason &&
      choice.modelSource !== catalogSourceId &&
      model === route.model &&
      sameContext &&
      currentProvider?.protocol === nextProvider?.protocol &&
      status.accountTypes?.[route.sourceId] === status.accountTypes?.[choice.modelSource] &&
      (!route.launchConfiguration ||
        route.launchConfiguration === status.accountTypes?.[choice.modelSource])
    ) {
      await client.switchRoute({
        conversationId: conversation.id,
        sourceId: choice.modelSource,
        model,
      });
      toast.success('Gateway selection saved. It applies when the agent is idle.');
      return conversation;
    }
  }
  if (needsNewSession && requireSession)
    throw new Error(
      'This route cannot safely resume the provider state. Start a new agent session.'
    );
  const sessionId = needsNewSession ? null : resumableSessionId(conversation);
  if (!sessionId && requireSession) throw new Error('The conversation has no session to resume');
  const currentType = conversation.type ?? 'pty';
  const nextType = type ?? currentType;
  await manager.killSession(conversation.id);
  const replacement = await manager.createConversation({
    id: crypto.randomUUID(),
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: conversation.providerId,
    title: conversation.title,
    type: nextType,
    autoApprove: conversation.autoApprove,
    // Options (chat modes, effort) belong to one UI's adapter.
    ...(nextType === currentType && { options: conversation.options }),
    isInitialConversation: conversation.isInitialConversation ?? undefined,
    ...(sessionId && { providerSessionId: sessionId }),
    ...(choice.modelSource !== undefined && { modelSource: choice.modelSource }),
    ...(choice.sourceModel && { sourceModel: choice.sourceModel }),
    ...(!usesProviderSource(choice) && choice.model && { model: choice.model }),
  });
  await manager.deleteConversation(conversation.id);
  return replacement;
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
  const [sourceTouched, setSourceTouched] = useState(false);
  const gatewayRoute = useQuery({
    queryKey: ['modelGateway', 'route', conversation.id],
    enabled: Boolean(conversation.modelSource?.startsWith('gateway:')),
    queryFn: async () => (await getModelGatewayClient()).route({ conversationId: conversation.id }),
  });
  useEffect(() => {
    if (gatewayRoute.data && !sourceTouched)
      setSource({
        modelSource: gatewayRoute.data.pending?.sourceId ?? gatewayRoute.data.sourceId,
        sourceModel: gatewayRoute.data.model,
      });
  }, [gatewayRoute.data, sourceTouched]);
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
  const gatewaySelection = Boolean(
    conversation.modelSource?.startsWith('gateway:') && source.modelSource?.startsWith('gateway:')
  );
  const changesIdentity = Boolean(
    gatewayRoute.data?.requiresNewSession ||
    (conversation.providerId === 'codex' && source.modelSource !== conversation.modelSource) ||
    ((source.modelSource === catalogSourceId || conversation.modelSource === catalogSourceId) &&
      (source.modelSource !== conversation.modelSource ||
        source.sourceModel !== conversation.sourceModel))
  );
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
        <Dialog.Title>
          {gatewaySelection ? 'Switch source for' : 'Restart'}{' '}
          {agentDisplayName(conversation.providerId)}
        </Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <p className="text-xs text-foreground-muted">
            {changesIdentity
              ? 'This change starts a new agent session so provider-bound history is not sent to an incompatible route. The original session remains in History.'
              : gatewaySelection
                ? 'Choose a gateway model or the agent’s own login. Route changes that affect protocol, model or capabilities require a restart.'
                : resumes
                  ? 'The agent stops and the same session continues on the source below. A reply in progress is cut off.'
                  : 'This conversation has no session to resume yet, so a new one starts on the source below.'}
          </p>
          {gatewayRoute.data?.restartReason ? (
            <p role="status" className="text-xs text-foreground-muted">
              {gatewayRoute.data.restartReason}
            </p>
          ) : null}
          <ModelSourceSelect
            remote={Boolean(connectionId)}
            agentId={conversation.providerId}
            value={source}
            onChange={(next) => {
              setSourceTouched(true);
              setSource(next);
            }}
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
          {busy ? 'Applying…' : gatewaySelection ? 'Apply source' : 'Restart'}
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
      label: conversation.modelSource?.startsWith('gateway:')
        ? 'Change gateway model or connection…'
        : 'Change model or connection…',
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
