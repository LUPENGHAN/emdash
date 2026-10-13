import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import { Field, Input, Select, Switch, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { libraryProjects } from '@core/features/agent-library/contributions/browser/scope-picker';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { agentDisplayName } from '@core/features/conversations/browser/handoff';
import {
  DEFAULT_RESUME_WRITING_SETTINGS,
  type ResumeWritingSettings,
} from '@core/features/conversations/contributions/resume-settings';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';

type Choice = { id: string; label: string };

export const ResumeWritingSettingsPage = observer(function ResumeWritingSettingsPage() {
  const { value, updateAsync } = useAppSettingsKey('resumeWriting');
  const settings = value ?? DEFAULT_RESUME_WRITING_SETTINGS;
  const { projectId, taskId, conversationId } = settings;

  const { data: projectConversations = [] } = useQuery({
    queryKey: ['resume-writing', 'conversations', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => (await getConversationsClient()).getConversationsForProject({ projectId }),
  });

  const projects: Choice[] = libraryProjects().map((project) => ({
    id: project.id,
    label: project.name,
  }));
  const tasks = taskChoices(projectId, projectConversations);
  const conversations: Choice[] = projectConversations
    .filter((conversation) => conversation.taskId === taskId)
    .map((conversation) => ({
      id: conversation.id,
      label: `${agentDisplayName(conversation.providerId)} · ${conversation.title || conversation.id}`,
    }));

  const save = (patch: Partial<ResumeWritingSettings>) => {
    const next: Partial<ResumeWritingSettings> = { ...patch };
    if (patch.clockTime !== undefined || patch.enabled) {
      next.clockDay = clockDayIfPassed(patch.clockTime ?? settings.clockTime);
    }
    const retargets = (
      ['projectId', 'taskId', 'conversationId', 'onWindowReset', 'enabled'] as const
    ).some((field) => field in patch);
    if (retargets) {
      next.usagePercents = null;
      next.quotaKey = null;
    }
    updateAsync(next).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Continue writing"
        description="Emdash sends a follow-up to a conversation by itself, or moves it to another official account when the current one runs out. The app has to be open."
      />
      <SettingsSection>
        <label className="flex items-center justify-between gap-4 text-sm">
          On
          <Switch checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />
        </label>
      </SettingsSection>
      <SettingsSection title="Conversation">
        <div className="space-y-4">
          <ChoiceField
            label="Project"
            placeholder="Choose a project"
            value={projectId}
            choices={projects}
            onChange={(id) => save({ projectId: id, taskId: '', conversationId: '' })}
          />
          <ChoiceField
            label="Task"
            placeholder={projectId ? 'Choose a task' : 'Choose a project first'}
            value={taskId}
            choices={tasks}
            disabled={!projectId}
            onChange={(id) => save({ taskId: id, conversationId: '' })}
          />
          <ChoiceField
            label="Agent"
            placeholder={
              !taskId
                ? 'Choose a task first'
                : conversations.length
                  ? 'Choose a conversation'
                  : 'This task has no conversations'
            }
            value={conversationId}
            choices={conversations}
            disabled={!taskId || conversations.length === 0}
            onChange={(id) => save({ conversationId: id })}
          />
          <Field.Root>
            <Field.Label>Message</Field.Label>
            <Input value={settings.text} onChange={(event) => save({ text: event.target.value })} />
          </Field.Root>
        </div>
      </SettingsSection>
      <SettingsSection title="Send in the same conversation">
        <div className="space-y-4">
          <Field.Root>
            <Field.Label>Clock time</Field.Label>
            <Input
              type="time"
              value={settings.clockTime}
              onChange={(event) => save({ clockTime: event.target.value })}
            />
          </Field.Root>
          <label className="flex items-center justify-between gap-4 text-sm">
            When the usage window resets
            <Switch
              checked={settings.onWindowReset}
              onCheckedChange={(onWindowReset) => save({ onWindowReset })}
            />
          </label>
        </div>
      </SettingsSection>
      <SettingsSection title="Hand off to another official account">
        <Field.Root>
          <Field.Label>When the current account reaches (%)</Field.Label>
          <Input
            type="number"
            min={1}
            max={100}
            placeholder="Off"
            value={settings.quotaPercent ?? ''}
            onChange={(event) => {
              const parsed = Math.round(Number(event.target.value));
              if (event.target.value === '' || !Number.isFinite(parsed)) {
                save({ quotaPercent: null });
              } else {
                save({ quotaPercent: Math.min(100, Math.max(1, parsed)) });
              }
            }}
          />
          <Field.Description>
            Opens a new conversation with the same agent on the next official account that has room
            left, and sends it the handoff.
          </Field.Description>
        </Field.Root>
      </SettingsSection>
      <SettingsSection>
        <label className="flex items-center justify-between gap-4 text-sm">
          Ask before sending
          <Switch checked={settings.confirm} onCheckedChange={(confirm) => save({ confirm })} />
        </label>
      </SettingsSection>
    </div>
  );
});

function ChoiceField({
  label,
  placeholder,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  choices: Choice[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const selected = choices.find((choice) => choice.id === value);
  return (
    <Field.Root>
      <Field.Label>{label}</Field.Label>
      <Select.Root
        value={value || undefined}
        disabled={disabled}
        onValueChange={(next) => next && onChange(String(next))}
      >
        <Select.Trigger appearance="input" className="w-full">
          <Select.Value placeholder={placeholder}>{selected?.label}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start" width="trigger">
          {choices.map((choice) => (
            <Select.Item key={choice.id} value={choice.id}>
              {choice.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </Field.Root>
  );
}

function taskChoices(projectId: string, conversations: readonly { taskId: string }[]): Choice[] {
  if (!projectId) return [];
  const known = new Map<string, string>();
  for (const task of getTaskManagerStore(projectId)?.tasks.values() ?? []) {
    known.set(task.data.id, task.displayName);
  }
  for (const conversation of conversations) {
    if (!known.has(conversation.taskId)) known.set(conversation.taskId, conversation.taskId);
  }
  return [...known].map(([id, label]) => ({ id, label }));
}

function clockDayIfPassed(clockTime: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clockTime.trim());
  if (!match) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (now.getTime() < target.getTime()) return null;
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
