import { Button, Input, Select, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { PROVIDER_CAPABLE_AGENTS } from '@core/features/model-providers/api';
import {
  getProjectStore,
  getProjectManagerStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { getCoordinationClient } from '../api/browser/client';
import type { AgentSelection, AssignedTask, Coordinator, ProjectAccess } from '../api/types';
import { CreateCrossProjectMainAgent } from './cross-project-main-agents';
import { TakeOverTaskForm } from './take-over-task-form';

export const CoordinatorTaskPanel = observer(function CoordinatorTaskPanel({
  children,
}: {
  children: ReactNode;
}) {
  const { projectId, taskId } = useTaskViewContext();
  const task = getTaskStore(projectId, taskId);
  if (task?.data.type !== 'coordination') return children;
  return <CoordinatorContent taskId={taskId}>{children}</CoordinatorContent>;
});

const CoordinatorContent = observer(function CoordinatorContent({
  taskId,
  children,
}: {
  taskId: string;
  children: ReactNode;
}) {
  const [tab, setTab] = useState<'conversation' | 'tasks' | 'settings'>('conversation');
  const queryClient = useQueryClient();
  const key = ['coordinator', taskId];
  const { data: record } = useQuery({
    queryKey: key,
    queryFn: async () => (await getCoordinationClient()).getByTask({ taskId }),
  });
  const { navigate } = useNavigate();
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getCoordinationClient()
      .then(async (client) => {
        const next = await client.events.subscribe(undefined, {
          onEvent: () => {
            void queryClient.invalidateQueries({ queryKey: ['coordinator', taskId] });
          },
          onGap: () => {
            void queryClient.invalidateQueries({ queryKey: ['coordinator', taskId] });
          },
        });
        if (disposed) next();
        else unsubscribe = next;
      })
      .catch((error) =>
        toast.error('Could not subscribe to main agent updates', { description: String(error) })
      );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [taskId, queryClient]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button
          data-testid="coordinator-conversation-tab"
          variant={tab === 'conversation' ? 'secondary' : 'ghost'}
          onClick={() => setTab('conversation')}
        >
          Conversation
        </Button>
        <Button
          data-testid="coordinator-tasks-tab"
          variant={tab === 'tasks' ? 'secondary' : 'ghost'}
          onClick={() => setTab('tasks')}
        >
          Assigned tasks ({Object.keys(record?.tasks ?? {}).length})
        </Button>
        <Button
          data-testid="coordinator-settings-tab"
          variant={tab === 'settings' ? 'secondary' : 'ghost'}
          onClick={() => setTab('settings')}
        >
          Delegation defaults
        </Button>
      </div>
      {tab === 'conversation' ? (
        <div className="min-h-0 flex-1">{children}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!record ? (
            <p>Loading main agent…</p>
          ) : tab === 'settings' ? (
            <div className="space-y-6">
              <ProjectAccessSettings record={record} />
              <MainConversationSettings record={record} />
              <DelegationDefaults record={record} />
              <CreateCrossProjectMainAgent record={record} />
            </div>
          ) : (
            <>
              <TakeOverTaskForm record={record} />
              {Object.values(record.tasks).length === 0 && (
                <p>No tasks assigned yet. Describe your goal in the main agent conversation.</p>
              )}
              {Object.values(record.tasks).map((task) => (
                <article key={task.taskId} className="mb-3 rounded-lg border border-border p-3">
                  <Button
                    variant="ghost"
                    disabled={task.taskCreated === false}
                    onClick={() =>
                      navigate(taskViewDef({ projectId: task.projectId, taskId: task.taskId }))
                    }
                  >
                    {task.name}
                  </Button>
                  <span className="ml-2 text-xs text-foreground-muted">
                    {getProjectStore(task.projectId)?.name ?? 'Project unavailable'} · {task.state}
                  </span>
                  {task.taskCreated === false && task.state === 'blocked' && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        void getCoordinationClient()
                          .then((client) =>
                            client.cancelPendingTask({ id: record.id, taskId: task.taskId })
                          )
                          .then(() => queryClient.invalidateQueries({ queryKey: key }))
                          .catch((error) =>
                            toast.error('Could not cancel task', { description: String(error) })
                          );
                      }}
                    >
                      Cancel waiting task
                    </Button>
                  )}
                  {task.blockedReason && <p className="mt-2 text-sm">{task.blockedReason}</p>}
                  {!!task.dependsOn?.length && (
                    <p className="mt-2 text-xs text-foreground-muted">
                      Prerequisites: {task.dependsOn.join(', ')}
                    </p>
                  )}
                  {task.result && (
                    <div className="mt-2 space-y-2 text-sm">
                      <p className="whitespace-pre-wrap">{task.result.summary}</p>
                      {task.result.checks.map((check, index) => (
                        <p key={index}>
                          {check.passed ? 'Passed' : 'Failed'}: <code>{check.command}</code>
                          {check.output && (
                            <span className="block whitespace-pre-wrap">{check.output}</span>
                          )}
                        </p>
                      ))}
                      {task.result.commits.length > 0 && (
                        <p>Commits: {task.result.commits.join(', ')}</p>
                      )}
                      {task.result.prUrls.map((url) => (
                        <p key={url}>PR: {url}</p>
                      ))}
                      {task.result.unresolved.map((issue, index) => (
                        <p key={index}>{issue}</p>
                      ))}
                      {task.state === 'review' && (
                        <ResultReview
                          record={record}
                          task={task}
                          onReviewed={() => queryClient.invalidateQueries({ queryKey: key })}
                        />
                      )}
                      {task.review && <p>Review: {task.review.note}</p>}
                    </div>
                  )}
                </article>
              ))}
              {record.events.some((event) => event.error && event.state === 'pending') && (
                <div className="space-y-2">
                  <p>Some results are saved and waiting for delivery to the main agent.</p>
                  <Button
                    onClick={() => {
                      void getCoordinationClient()
                        .then((client) => client.retryDelivery({ id: record.id }))
                        .catch((error) =>
                          toast.error('Could not deliver results', { description: String(error) })
                        );
                    }}
                  >
                    Retry result delivery
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

const ProjectAccessSettings = observer(function ProjectAccessSettings({
  record,
}: {
  record: Coordinator;
}) {
  const [access, setAccess] = useState<ProjectAccess>(record.projectAccess ?? { mode: 'all' });
  const [linked, setLinked] = useState(record.projectIds);
  const [saving, setSaving] = useState(false);
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt
  );
  return (
    <div className="max-w-lg space-y-3">
      <p className="text-sm">Project access</p>
      <Select.Root
        value={access.mode}
        onValueChange={(value) =>
          setAccess(
            value === 'selected'
              ? { mode: 'selected', projectIds: [record.projectId] }
              : { mode: 'all' }
          )
        }
      >
        <Select.Trigger data-testid="coordinator-project-access">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item data-testid="coordinator-access-all" value="all">
            All accessible Emdash projects
          </Select.Item>
          <Select.Item data-testid="coordinator-access-selected" value="selected">
            Selected projects
          </Select.Item>
        </Select.Content>
      </Select.Root>
      <p className="text-xs text-foreground-muted">
        Linked projects organize context. Allowed projects control discovery and delegation. Workers
        only receive explicitly granted project access.
      </p>
      <div className="space-y-2">
        {projects.map((project) => (
          <div key={project.id} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={linked.includes(project.id)}
                onChange={(event) =>
                  setLinked(
                    event.target.checked
                      ? [...linked, project.id]
                      : linked.filter((id) => id !== project.id)
                  )
                }
              />{' '}
              Linked
            </label>
            {access.mode === 'selected' && (
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={access.projectIds.includes(project.id)}
                  onChange={(event) =>
                    setAccess({
                      mode: 'selected',
                      projectIds: event.target.checked
                        ? [...access.projectIds, project.id]
                        : access.projectIds.filter((id) => id !== project.id),
                    })
                  }
                />{' '}
                Allowed
              </label>
            )}
          </div>
        ))}
      </div>
      <Button
        data-testid="coordinator-save-access"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          void getCoordinationClient()
            .then((client) =>
              client.update({ id: record.id, projectAccess: access, projectIds: linked })
            )
            .then(() => toast.success('Project access saved'))
            .catch((error) =>
              toast.error('Could not save project access', { description: String(error) })
            )
            .finally(() => setSaving(false));
        }}
      >
        Save project access
      </Button>
    </div>
  );
});

const MainConversationSettings = observer(function MainConversationSettings({
  record,
}: {
  record: Coordinator;
}) {
  const [selected, setSelected] = useState(record.conversationId);
  const [saving, setSaving] = useState(false);
  const conversations = Array.from(
    getConversationsForTask(record.taskId)?.conversations.values() ?? []
  );
  useEffect(() => {
    setSelected(record.conversationId);
  }, [record.conversationId]);
  return (
    <div className="max-w-lg space-y-3">
      <p className="text-sm">Main conversation</p>
      <p className="text-xs text-foreground-muted">
        Create or configure a conversation in the conversation tabs, then choose it here to receive
        task results. Assigned tasks and result history stay with this main agent.
      </p>
      <Select.Root
        value={selected}
        onValueChange={(value) => {
          if (value) setSelected(value);
        }}
      >
        <Select.Trigger data-testid="coordinator-main-conversation">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {!conversations.some(
            (conversation) => conversation.data.id === record.conversationId
          ) && (
            <Select.Item value={record.conversationId}>Main conversation unavailable</Select.Item>
          )}
          {conversations.map(({ data }) => (
            <Select.Item key={data.id} value={data.id}>
              {data.title} · {data.providerId}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <Button
        data-testid="coordinator-bind-main"
        disabled={saving || selected === record.conversationId}
        onClick={() => {
          setSaving(true);
          void getCoordinationClient()
            .then((client) => client.bindConversation({ id: record.id, conversationId: selected }))
            .then(() => toast.success('Main conversation updated'))
            .catch((error) =>
              toast.error('Could not change main conversation', { description: String(error) })
            )
            .finally(() => setSaving(false));
        }}
      >
        Use as main conversation
      </Button>
    </div>
  );
});

function ResultReview({
  record,
  task,
  onReviewed,
}: {
  record: Coordinator;
  task: AssignedTask;
  onReviewed(): Promise<unknown>;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const review = (accepted: boolean) => {
    if (!accepted && !note.trim()) {
      toast.error('Describe the changes needed before requesting a revision.');
      return;
    }
    setSaving(true);
    void getCoordinationClient()
      .then((client) =>
        client.review({
          id: record.id,
          taskId: task.taskId,
          accepted,
          resultVersion: task.resultVersion,
          note: note.trim() || 'Reviewed by the user in Emdash.',
        })
      )
      .then(onReviewed)
      .catch((error) => toast.error('Could not review result', { description: String(error) }))
      .finally(() => setSaving(false));
  };
  return (
    <div className="space-y-2">
      <Input
        aria-label="Review feedback"
        value={note}
        placeholder="Review feedback"
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          data-testid="coordinator-accept-result"
          disabled={saving}
          onClick={() => review(true)}
        >
          Accept reviewed result
        </Button>
        <Button variant="secondary" disabled={saving} onClick={() => review(false)}>
          Request changes
        </Button>
      </div>
    </div>
  );
}

function DelegationDefaults({ record }: { record: Coordinator }) {
  const [draft, setDraft] = useState<AgentSelection>(record.delegationDefaults);
  const { value: providers } = useAppSettingsKey('modelProviders');
  const [saving, setSaving] = useState(false);
  const {
    data: resolved,
    isPending,
    error,
  } = useQuery({
    queryKey: ['coordinator-selection', record.id, draft],
    queryFn: async () =>
      (await getCoordinationClient()).selectionOptions({ id: record.id, selection: draft }),
  });
  const effortOptions = resolved?.effortOptions ?? {};

  return (
    <form
      className="max-w-lg space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void getCoordinationClient()
          .then((client) => client.update({ id: record.id, delegationDefaults: draft }))
          .then(() => toast.success('Delegation defaults saved'))
          .catch((error) =>
            toast.error('Could not save delegation defaults', { description: String(error) })
          )
          .finally(() => setSaving(false));
      }}
    >
      <p className="text-sm">
        Omitted fields follow the selected agent defaults in Settings. Explicit task selections take
        priority.
      </p>
      <label className="block text-sm">Agent</label>
      <Select.Root
        value={draft.agent ?? 'inherit'}
        onValueChange={(value) =>
          setDraft({ ...draft, agent: value === 'inherit' ? undefined : (value ?? undefined) })
        }
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">Follow default</Select.Item>
          {PROVIDER_CAPABLE_AGENTS.map((id) => (
            <Select.Item key={id} value={id}>
              {id}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <label className="block text-sm">Connection</label>
      <Select.Root
        value={draft.connection ?? 'inherit'}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            connection: value === 'gateway' || value === 'official' ? value : undefined,
            ...(value === 'official' && { supplierId: undefined }),
          })
        }
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">Follow default</Select.Item>
          <Select.Item value="gateway">Gateway</Select.Item>
          <Select.Item value="official">Official login</Select.Item>
        </Select.Content>
      </Select.Root>
      <label className="block text-sm">Supplier</label>
      <Select.Root
        value={draft.supplierId ?? 'inherit'}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            supplierId: value === 'inherit' ? undefined : (value ?? undefined),
            ...(value && value !== 'inherit' && { connection: 'gateway' }),
          })
        }
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">Use model alias / default</Select.Item>
          {(providers?.providers ?? [])
            .filter((provider) => !provider.account)
            .map((provider) => (
              <Select.Item key={provider.id} value={provider.id}>
                {provider.name}
              </Select.Item>
            ))}
        </Select.Content>
      </Select.Root>
      <label className="block text-sm" htmlFor="delegation-model">
        Model alias or supplier model
      </label>
      <Input
        id="delegation-model"
        value={draft.model ?? ''}
        onChange={(event) => setDraft({ ...draft, model: event.target.value || undefined })}
      />
      <label className="block text-sm" htmlFor="delegation-effort">
        Effort
      </label>
      <Select.Root
        value={draft.effort === null ? 'adapter-default' : (draft.effort ?? 'inherit')}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            effort: value === 'inherit' ? undefined : value === 'adapter-default' ? null : value,
          })
        }
      >
        <Select.Trigger id="delegation-effort">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">Follow agent settings</Select.Item>
          <Select.Item value="adapter-default">Follow model / agent default</Select.Item>
          {draft.effort && !effortOptions[draft.effort] && (
            <Select.Item value={draft.effort}>{draft.effort} (unsupported)</Select.Item>
          )}
          {Object.entries(effortOptions).map(([id, option]) => (
            <Select.Item key={id} value={id}>
              {option.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      {resolved && (
        <div className="space-y-1 text-xs text-foreground-muted">
          <p>
            Effective agent: {resolved.values.agent} · {resolved.values.connection}
          </p>
          <p>
            Model: {resolved.values.model ?? 'Agent default'} · {resolved.sources.model}
          </p>
          <p>
            Effort: {resolved.values.effort ?? 'Model / agent default'} · {resolved.sources.effort}
          </p>
          {Object.keys(effortOptions).length === 0 && (
            <p>This combination has no selectable effort.</p>
          )}
          {resolved.errors.map((message) => (
            <p key={message} role="alert">
              {message}
            </p>
          ))}
        </div>
      )}
      {error && <p role="alert">Could not resolve defaults: {String(error)}</p>}
      <Button type="submit" disabled={saving || isPending || !!error || !!resolved?.errors.length}>
        Save defaults
      </Button>
    </form>
  );
}
