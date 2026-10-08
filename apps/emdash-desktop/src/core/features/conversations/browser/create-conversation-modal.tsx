import { formatHostRef } from '@emdash/core/primitives/host/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
} from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { readProviderSettings } from '@core/features/conversations/api/browser/provider-preferences';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { useConversationLaunchSettings } from '@core/features/conversations/api/browser/use-conversation-launch-settings';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import { ConversationTransportToggle } from '@core/features/conversations/contributions/browser/conversation-transport-toggle';
import {
  modelSourceUnavailableMessage,
  usesProviderSource,
  type ModelSourceValue,
} from '@core/features/model-providers/api';
import { ModelSourceSelect } from '@core/features/model-providers/contributions/browser/model-source-select';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { agentSupportsAcp, agentSupportsAutoApprove } from '@core/primitives/agents/api';
import type { ConversationType } from '@core/primitives/conversations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { agentDisplayName, collectHandoffSummary } from './handoff';

// Select value for the "type any model id" row; not a real model id.
const CUSTOM_MODEL_VALUE = '__emdash_custom_model__';

/** Hand a conversation's work to a new one: the modal picks agent, model and source. */
export type ConversationHandoff = {
  fromConversationId: string;
  providerId: AgentProviderId;
  /** The source's UI, kept when the target supports it. */
  type: ConversationType;
  title: string;
};

export const CreateConversationModal = observer(function CreateConversationModal({
  projectId,
  taskId,
  handoff,
}: {
  projectId: string;
  taskId: string;
  handoff?: ConversationHandoff;
}) {
  const { complete } = useModalController('createConversationModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const { providerId, setProviderOverride, createDisabled } = useEffectiveProvider(
    connectionId,
    handoff?.providerId
  );
  const conversationMgr = conversationRegistry.get(taskId);
  const handoffSource = handoff
    ? conversationMgr?.conversations.get(handoff.fromConversationId)?.data
    : undefined;
  // Handoff: a note for the next agent, and optionally a summary by the source agent first.
  const [handoffNote, setHandoffNote] = useState('');
  const [askSummary, setAskSummary] = useState(false);
  const [summaryWait, setSummaryWait] = useState<{ startedAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stopWaiting = useRef<'skip' | 'cancel' | null>(null);
  useEffect(() => {
    if (!summaryWait) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [summaryWait]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(projectId);
  useCloseGuard(isSubmitting);

  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const selectedAgent = agents?.find((a) => a.id === providerId);
  const host = formatHostRef(hostRefFromConnectionId(connectionId));
  const launchSettings = useConversationLaunchSettings(
    host,
    providerId,
    selectedAgent?.capabilities
  );
  const modelsCapability = selectedAgent?.capabilities.models;
  const modelOptions =
    modelsCapability?.kind === 'selectable' ? modelsCapability.modelOptions : null;

  // Sessions started outside Emdash in this task's directory, resumable by id.
  const { data: importableSessions = [] } = useQuery({
    queryKey: ['importableSessions', projectId, taskId],
    enabled: !liveActionDisabledReason && !handoff,
    gcTime: 0,
    queryFn: async () => {
      try {
        return await (await getConversationsClient()).listImportableSessions({ projectId, taskId });
      } catch {
        return [];
      }
    },
  });
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const [source, setSource] = useState<ModelSourceValue>({});
  const providerSource = usesProviderSource(source);
  const agentSessions = importableSessions.filter((session) => session.providerId === providerId);
  const resumeSession =
    agentSessions.find((session) => session.sessionId === resumeSessionId) ?? null;

  // A resumed session can open in either UI: chat loads it with session/load.
  const showAcpToggle = agentSupportsAcp(selectedAgent?.capabilities);
  // A handoff starts in the source's UI where the target has it, and may switch (the
  // terminal is where auto-approve is set) without changing the agent's own preference.
  const [handoffUi, setHandoffUi] = useState<'acp' | 'pty' | null>(null);
  const handoffWantsAcp = (handoffUi ?? handoff?.type) === 'acp';
  const useAcp = handoff
    ? showAcpToggle && handoffWantsAcp
    : showAcpToggle && launchSettings.useChatUi;
  const transport = useAcp ? 'acp' : 'pty';
  const showAutoApproveToggle = agentSupportsAutoApprove(selectedAgent?.capabilities, transport);
  const skipPermissions = showAutoApproveToggle && launchSettings.autoApprove;

  // Terminal sessions pass the id to the CLI's --model flag verbatim, so any model the
  // CLI knows works; chat sessions pick theirs in the composer.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [customModelDraft, setCustomModelDraft] = useState<string | null>(null);
  const showModelSelect = !useAcp && !resumeSession && !providerSource && modelOptions !== null;
  const isCustomModel =
    customModelDraft !== null ||
    (selectedModel !== null && modelOptions !== null && modelOptions[selectedModel] === undefined);

  const title = handoff
    ? handoff.title
    : resumeSession
      ? resumeSession.title.slice(0, 80)
      : providerId
        ? nextDefaultConversationTitle(
            providerId,
            Array.from(
              conversationMgr?.conversations.values() ?? [],
              (conversation) => conversation.data
            )
          )
        : 'Conversation';

  const handleProviderChange = useCallback(
    (next: typeof providerId) => {
      setProviderOverride(next);
      setSelectedModel(null);
      setCustomModelDraft(null);
      setResumeSessionId(null);
      setSource({});
    },
    [setProviderOverride]
  );

  const handleCreateConversation = useCallback(async () => {
    if (
      liveActionDisabledReason ||
      createDisabled ||
      !launchSettings.ready ||
      isSubmitting ||
      !conversationMgr ||
      !providerId
    ) {
      return;
    }
    const id = crypto.randomUUID();
    setIsSubmitting(true);
    setError(null);
    try {
      const settings = await readProviderSettings({ host, providerId });
      const conversationType: ConversationType = useAcp ? 'acp' : 'pty';
      // Asked for only on confirm; the source agent spends its own tokens on it.
      let summaryPath: string | null = null;
      if (handoff && askSummary && handoffSource) {
        stopWaiting.current = null;
        setSummaryWait({ startedAt: Date.now() });
        try {
          summaryPath = await collectHandoffSummary(handoffSource, () =>
            Boolean(stopWaiting.current)
          );
        } finally {
          setSummaryWait(null);
        }
        if (stopWaiting.current === 'cancel') {
          setIsSubmitting(false);
          return;
        }
      }
      // Written only on confirm, so a cancelled handoff leaves no transcript behind.
      const handoffPrompt = handoff
        ? (
            await (
              await getConversationsClient()
            ).prepareHandoff({
              conversationId: handoff.fromConversationId,
              ...(summaryPath && { summaryPath }),
              ...(handoffNote.trim() && { note: handoffNote.trim() }),
            })
          ).prompt
        : undefined;
      await conversationMgr.createConversation({
        projectId,
        taskId,
        id,
        autoApprove: showAutoApproveToggle && settings.pty.autoApprove,
        provider: providerId,
        title,
        options: conversationType === 'acp' ? settings.acp.options : undefined,
        type: conversationType,
        ...(showModelSelect && selectedModel && { model: selectedModel }),
        ...(source.modelSource !== undefined && { modelSource: source.modelSource }),
        ...(source.sourceModel && { sourceModel: source.sourceModel }),
        providerSessionId: resumeSession?.sessionId,
        ...(handoffPrompt !== undefined &&
          (conversationType === 'acp'
            ? { initialQueue: [{ text: handoffPrompt }] }
            : { initialPrompt: handoffPrompt })),
      });
      setIsSubmitting(false);
      complete({ conversationId: id, type: conversationType });
    } catch (createError) {
      setError(
        modelSourceUnavailableMessage(createError) ??
          (handoff ? 'Failed to hand off the conversation' : 'Failed to create conversation')
      );
      setIsSubmitting(false);
    }
  }, [
    handoff,
    handoffSource,
    askSummary,
    handoffNote,
    conversationMgr,
    liveActionDisabledReason,
    createDisabled,
    launchSettings.ready,
    isSubmitting,
    providerId,
    title,
    complete,
    projectId,
    taskId,
    showAutoApproveToggle,
    showModelSelect,
    selectedModel,
    source,
    resumeSession,
    useAcp,
    host,
  ]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>{handoff ? 'Hand Off Conversation' : 'Create Conversation'}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <AgentSelector
              autoFocus
              value={providerId}
              onChange={handleProviderChange}
              connectionId={connectionId}
              trailingControl={
                showAcpToggle ? (
                  <ConversationTransportToggle
                    value={transport}
                    disabled={!launchSettings.ready || isSubmitting}
                    onValueChange={(value) =>
                      handoff ? setHandoffUi(value) : launchSettings.setUseChatUi(value === 'acp')
                    }
                  />
                ) : null
              }
            />
          </Field.Root>
          {handoff ? (
            <>
              <p className="text-xs text-foreground-muted">
                The new conversation starts with the recent turns, the git state and the path of the
                full transcript.
              </p>
              <Field.Root>
                <Field.Label>Note for the next agent (optional)</Field.Label>
                <Textarea
                  value={handoffNote}
                  rows={3}
                  placeholder="What it should do now, e.g. the importer migration, not the export page"
                  disabled={isSubmitting}
                  onChange={(event) => setHandoffNote(event.target.value)}
                />
              </Field.Root>
              {handoffSource ? (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={askSummary}
                    disabled={isSubmitting}
                    onCheckedChange={(checked) => setAskSummary(checked === true)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span>
                      First ask{' '}
                      <span translate="no">{agentDisplayName(handoffSource.providerId)}</span> for a
                      handoff summary
                    </span>
                    <span className="text-xs text-foreground-muted">
                      More accurate about where the work stands, but it spends that agent's quota
                      and takes a minute or two. Leave it off when the agent is out of quota.
                    </span>
                  </span>
                </label>
              ) : null}
              {summaryWait ? (
                <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 text-foreground-muted">
                    Waiting for the handoff summary…{' '}
                    {Math.max(0, Math.round((now - summaryWait.startedAt) / 1000))}s
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => (stopWaiting.current = 'skip')}>
                    Hand off without it
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => (stopWaiting.current = 'cancel')}
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
          {!handoff && agentSessions.length > 0 ? (
            <Field.Root>
              <Field.Label>Session</Field.Label>
              <Select.Root
                value={resumeSession?.sessionId ?? ''}
                onValueChange={(value) => setResumeSessionId(value || null)}
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value placeholder="New session">
                    {resumeSession ? resumeSession.title : 'New session'}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  <Select.Item value="">New session</Select.Item>
                  {agentSessions.map((session) => (
                    <Select.Item key={session.sessionId} value={session.sessionId}>
                      <span className="truncate">{session.title}</span>
                      <span className="ml-2 shrink-0 text-xs text-foreground-muted">
                        {formatDistanceToNow(session.updatedAt, { addSuffix: true })}
                      </span>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <Field.Description>
                Resume a session started outside Emdash in this directory.
              </Field.Description>
            </Field.Root>
          ) : null}
          <ModelSourceSelect agentId={providerId} value={source} onChange={setSource} />
          {showModelSelect && modelOptions ? (
            <Field.Root>
              <Field.Label>Model</Field.Label>
              <Select.Root
                value={isCustomModel ? CUSTOM_MODEL_VALUE : (selectedModel ?? '')}
                onValueChange={(value) => {
                  if (value === CUSTOM_MODEL_VALUE) {
                    setCustomModelDraft(selectedModel ?? '');
                    return;
                  }
                  setCustomModelDraft(null);
                  setSelectedModel(value || null);
                }}
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value placeholder="Default model">
                    {isCustomModel
                      ? 'Custom model…'
                      : selectedModel
                        ? (modelOptions[selectedModel]?.name ?? selectedModel)
                        : 'Default model'}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  <Select.Item value="">Default model</Select.Item>
                  {Object.entries(modelOptions).map(([id, option]) => (
                    <Select.Item key={id} value={id}>
                      {option.name}
                    </Select.Item>
                  ))}
                  <Select.Item value={CUSTOM_MODEL_VALUE}>Custom model…</Select.Item>
                </Select.Content>
              </Select.Root>
              {isCustomModel ? (
                <Input
                  className="mt-2"
                  autoFocus
                  placeholder={
                    providerId === 'opencode'
                      ? 'provider/model, e.g. deepseek/deepseek-chat'
                      : 'Model id, passed to --model'
                  }
                  value={customModelDraft ?? selectedModel ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCustomModelDraft(next);
                    setSelectedModel(next.trim() || null);
                  }}
                />
              ) : null}
            </Field.Root>
          ) : null}
          {showAutoApproveToggle ? (
            <Field.Root>
              <div className="flex items-center gap-2">
                <Switch
                  checked={skipPermissions}
                  disabled={!providerId || !launchSettings.ready || isSubmitting}
                  onCheckedChange={launchSettings.setAutoApprove}
                />
                <Field.Label>Auto-approve permissions</Field.Label>
              </div>
            </Field.Root>
          ) : null}
          {error && <p className="text-destructive text-xs">{error}</p>}
          {liveActionDisabledReason && (
            <p className="text-xs text-foreground-muted" role="note" tabIndex={0}>
              {liveActionDisabledReason}
            </p>
          )}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <ConfirmButton
          variant="primary"
          onClick={() => void handleCreateConversation()}
          disabled={
            Boolean(liveActionDisabledReason) ||
            createDisabled ||
            !launchSettings.ready ||
            isSubmitting
          }
        >
          {isSubmitting
            ? handoff
              ? 'Handing off...'
              : resumeSession
                ? 'Resuming...'
                : 'Creating...'
            : handoff
              ? 'Hand Off'
              : resumeSession
                ? 'Resume'
                : 'Create'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const createConversationModal = defineModal<{
  conversationId: string;
  type: ConversationType;
}>()({
  id: 'createConversationModal',
  component: CreateConversationModal,
  ignoreOutsidePressAfterWindowBlur: true,
});
