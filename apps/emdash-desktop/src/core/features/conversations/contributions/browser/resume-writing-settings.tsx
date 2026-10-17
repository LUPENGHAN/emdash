import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Field, Input, Select, Switch, toast } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { libraryProjects } from '@core/features/agent-library/contributions/browser/scope-picker';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { agentDisplayName } from '@core/features/conversations/browser/handoff';
import {
  addResumeJob,
  patchResumeJob,
  removeResumeJob,
} from '@core/features/conversations/browser/resume-jobs-store';
import {
  resumeJobSchema,
  type ResumeJob,
} from '@core/features/conversations/contributions/resume-settings';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';

type Choice = { id: string; label: string };

export const ResumeWritingSettingsPage = observer(function ResumeWritingSettingsPage() {
  const { value } = useAppSettingsKey('resumeWriting');
  const jobs = value?.jobs ?? [];

  const add = () => {
    void addResumeJob(resumeJobSchema.parse({ id: crypto.randomUUID() })).catch((error) => {
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
        actions={
          <Button variant="primary" onClick={add}>
            <Plus className="size-4" />
            Add
          </Button>
        }
      />
      {jobs.length === 0 ? (
        <SettingsSection>
          <p className="text-muted-foreground text-sm">
            No conversations yet. Add one to have Emdash continue it.
          </p>
        </SettingsSection>
      ) : (
        jobs.map((job) => <ResumeJobCard key={job.id} job={job} />)
      )}
    </div>
  );
});

const ResumeJobCard = observer(function ResumeJobCard({ job }: { job: ResumeJob }) {
  const openConfirmActionModal = useOpenModal('confirmActionModal');
  const { projectId, taskId, conversationId } = job;

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
  const conversation = projectConversations.find((item) => item.id === conversationId);
  const title = conversation
    ? `${agentDisplayName(conversation.providerId)} · ${conversation.title || conversation.id}`
    : 'New job';

  const save = (patch: Partial<ResumeJob>) => {
    const next: Partial<ResumeJob> = { ...patch };
    if (patch.clockTime !== undefined || patch.enabled) {
      next.clockDay = clockDayIfPassed(patch.clockTime ?? job.clockTime);
    }
    const retargets = (
      ['projectId', 'taskId', 'conversationId', 'onWindowReset', 'enabled'] as const
    ).some((field) => field in patch);
    if (retargets) {
      next.usagePercents = null;
      next.quotaKey = null;
    }
    patchResumeJob(job.id, next).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  const remove = () => {
    void (async () => {
      const outcome = await openConfirmActionModal({
        title: 'Remove this job?',
        variant: 'destructive',
        description: 'Its automatic continue messages stop.',
        confirmLabel: 'Remove',
      });
      if (outcome.success) await removeResumeJob(job.id);
    })().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <SettingsSection title={title}>
      <div className="space-y-8">
        <label className="flex items-center justify-between gap-4 text-sm">
          On
          <span className="flex items-center gap-3">
            <Switch checked={job.enabled} onCheckedChange={(enabled) => save({ enabled })} />
            <Button variant="ghost" icon aria-label="Remove" onClick={remove}>
              <X className="text-muted-foreground size-4" />
            </Button>
          </span>
        </label>
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
            <Input value={job.text} onChange={(event) => save({ text: event.target.value })} />
          </Field.Root>
        </div>
        <div className="space-y-4">
          <Field.Root>
            <Field.Label>Clock time</Field.Label>
            <Input
              type="time"
              value={job.clockTime}
              onChange={(event) => save({ clockTime: event.target.value })}
            />
          </Field.Root>
          <label className="flex items-center justify-between gap-4 text-sm">
            When the usage window resets
            <Switch
              checked={job.onWindowReset}
              onCheckedChange={(onWindowReset) => save({ onWindowReset })}
            />
          </label>
        </div>
        <Field.Root>
          <Field.Label>When the current account reaches (%)</Field.Label>
          <Input
            type="number"
            min={1}
            max={100}
            placeholder="Off"
            value={job.quotaPercent ?? ''}
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
        <label className="flex items-center justify-between gap-4 text-sm">
          Ask before sending
          <Switch checked={job.confirm} onCheckedChange={(confirm) => save({ confirm })} />
        </label>
      </div>
    </SettingsSection>
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
