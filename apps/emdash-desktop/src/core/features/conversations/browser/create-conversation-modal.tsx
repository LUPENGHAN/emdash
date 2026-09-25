import { formatHostRef } from '@emdash/core/primitives/host/api';
import { Dialog, Field, Input, Select, Switch } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import { providerPreferencesMemento } from '@core/features/conversations/contributions/mementos';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
// TODO(conversations-extraction): Pass task settings into the modal instead of importing task hooks.
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import { useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { agentSupportsAcp, agentSupportsAutoApprove } from '@core/primitives/agents/api';
import type { ConversationType } from '@core/primitives/conversations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { getMementoClient } from '@core/primitives/mementos/browser';
import { useMemento } from '@core/primitives/mementos/react';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { useLocalStorage } from '@core/primitives/react-hooks/browser/useLocalStorage';
import {
  patchProviderPreference,
  providerPreference,
  providerPreferenceKey,
} from './provider-preferences';

// Select value for the "type any model id" row; not a real model id.
const CUSTOM_MODEL_VALUE = '__emdash_custom_model__';

export const CreateConversationModal = observer(function CreateConversationModal({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { complete } = useModalController('createConversationModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const { providerId, setProviderOverride, createDisabled } = useEffectiveProvider(connectionId);
  const conversationMgr = conversationRegistry.get(taskId);
  const taskSettings = useTaskSettings();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoApproveOverride, setAutoApproveOverride] = useState<boolean | null>(null);
  const [useChatUiPreference, setUseChatUiPreference] = useLocalStorage(
    'initial-conversation:chat-ui-enabled',
    false
  );
  const [providerPreferences, setProviderPreferences] = useMemento(providerPreferencesMemento);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string | null>>({});
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(projectId);
  useCloseGuard(isSubmitting);

  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const selectedAgent = agents?.find((a) => a.id === providerId);
  const modelsCapability = selectedAgent?.capabilities.models;
  const modelOptions =
    modelsCapability?.kind === 'selectable' ? modelsCapability.modelOptions : null;

  // Sessions started outside Emdash in this task's directory, resumable by id.
  const { data: importableSessions = [] } = useQuery({
    queryKey: ['importableSessions', projectId, taskId],
    enabled: !liveActionDisabledReason,
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
  const agentSessions = importableSessions.filter((session) => session.providerId === providerId);
  const resumeSession =
    agentSessions.find((session) => session.sessionId === resumeSessionId) ?? null;

  const showAutoApproveToggle = agentSupportsAutoApprove(selectedAgent?.capabilities);
  // A resumed session can open in either UI: chat loads it with session/load.
  const showAcpToggle = agentSupportsAcp(selectedAgent?.capabilities);
  const useAcp = showAcpToggle && useChatUiPreference;
  const transport = useAcp ? 'acp' : 'pty';
  // Terminal sessions pass the id to the CLI's --model flag verbatim, so any
  // model the CLI knows works, including ones newer than the catalog above.
  const allowCustomModel = !useAcp;
  const host = formatHostRef(hostRefFromConnectionId(connectionId));
  const preferenceKey = providerId ? providerPreferenceKey(host, providerId, transport) : null;
  const savedPreference = providerId
    ? providerPreference(providerPreferences, host, providerId, transport)
    : undefined;
  const savedModelUnsupported =
    !allowCustomModel &&
    savedPreference?.model !== undefined &&
    modelOptions !== null &&
    modelOptions[savedPreference.model] === undefined;
  const hasModelOverride =
    preferenceKey !== null && Object.prototype.hasOwnProperty.call(modelOverrides, preferenceKey);
  const selectedModel =
    preferenceKey !== null && hasModelOverride
      ? (modelOverrides[preferenceKey] ?? null)
      : savedModelUnsupported
        ? null
        : (savedPreference?.model ?? null);
  const [customModelDraft, setCustomModelDraft] = useState<string | null>(null);
  const isCustomModel =
    allowCustomModel &&
    (customModelDraft !== null ||
      (selectedModel !== null &&
        modelOptions !== null &&
        modelOptions[selectedModel] === undefined));
  const setSelectedModel = useCallback(
    (model: string | null) => {
      if (!preferenceKey) return;
      setModelOverrides((current) => ({ ...current, [preferenceKey]: model }));
    },
    [preferenceKey]
  );
  const skipPermissions =
    showAutoApproveToggle && (autoApproveOverride ?? taskSettings.autoApproveByDefault);
  const title = resumeSession
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
      setCustomModelDraft(null);
      setResumeSessionId(null);
    },
    [setProviderOverride]
  );

  const handleCreateConversation = useCallback(async () => {
    if (
      liveActionDisabledReason ||
      createDisabled ||
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
      const conversationType: ConversationType = useAcp ? 'acp' : 'pty';
      await conversationMgr.createConversation({
        projectId,
        taskId,
        id,
        autoApprove: skipPermissions,
        provider: providerId,
        title,
        // A resumed session keeps the model it was started with.
        model: resumeSession ? undefined : (selectedModel ?? undefined),
        modeId: conversationType === 'acp' ? savedPreference?.modeId : undefined,
        effort: conversationType === 'acp' ? savedPreference?.effort : undefined,
        collaborationMode:
          conversationType === 'acp' ? savedPreference?.collaborationMode : undefined,
        type: conversationType,
        providerSessionId: resumeSession?.sessionId,
      });
      // A resumed session's choices are its own; don't remember them as defaults.
      if (!resumeSession) {
        try {
          setProviderPreferences((current) =>
            patchProviderPreference(current, host, providerId, conversationType, {
              model: selectedModel,
            })
          );
        } catch (preferenceError) {
          getMementoClient().reportError(preferenceError);
        }
      }
      setIsSubmitting(false);
      complete({ conversationId: id, type: conversationType });
    } catch {
      setError('Failed to create conversation');
      setIsSubmitting(false);
    }
  }, [
    conversationMgr,
    liveActionDisabledReason,
    createDisabled,
    isSubmitting,
    providerId,
    title,
    complete,
    projectId,
    taskId,
    skipPermissions,
    selectedModel,
    resumeSession,
    useAcp,
    host,
    savedPreference?.effort,
    savedPreference?.modeId,
    savedPreference?.collaborationMode,
    setProviderPreferences,
  ]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Create Conversation</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <Field.Label>Agent</Field.Label>
            <AgentSelector
              autoFocus
              value={providerId}
              onChange={handleProviderChange}
              connectionId={connectionId}
            />
          </Field.Root>
          {agentSessions.length > 0 ? (
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
          {!resumeSession &&
          modelOptions &&
          (allowCustomModel || Object.keys(modelOptions).length > 0) ? (
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
                  {allowCustomModel ? (
                    <Select.Item value={CUSTOM_MODEL_VALUE}>Custom model…</Select.Item>
                  ) : null}
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
                  disabled={!providerId || taskSettings.loading || taskSettings.saving}
                  onCheckedChange={setAutoApproveOverride}
                />
                <Field.Label>Auto-approve permissions</Field.Label>
              </div>
            </Field.Root>
          ) : null}
          {showAcpToggle ? (
            <Field.Root>
              <div className="flex items-center gap-2">
                <Switch checked={useAcp} onCheckedChange={setUseChatUiPreference} />
                <Field.Label>Use chat UI</Field.Label>
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
          disabled={Boolean(liveActionDisabledReason) || createDisabled || isSubmitting}
        >
          {isSubmitting
            ? resumeSession
              ? 'Resuming...'
              : 'Creating...'
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
