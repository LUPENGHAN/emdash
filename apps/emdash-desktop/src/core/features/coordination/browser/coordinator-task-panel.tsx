import { Button, Input, Select, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { openFileInTaskEditor } from '@core/features/editor/api/browser/open-file-in-file-editor';
import { getMemoryClient } from '@core/features/memory/api/browser/client';
import {
  getProjectStore,
  getProjectManagerStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getRequirementsClient } from '@core/features/requirements/api/browser/client';
import { TaskPullRequestStatus } from '@core/features/source-control/contributions/browser/task-pull-requests';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { useMemento } from '@core/primitives/mementos/react';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { getCoordinationClient } from '../api/browser/client';
import { isMainAgentHostProject } from '../api/main-agent-host';
import type { AssignedTask, Coordinator, ProjectAccess } from '../api/types';
import { coordinatorViewMemento } from '../contributions/mementos';
import { CoordinatorDocumentsPanel } from './coordinator-documents-panel';
import { TakeOverTaskForm } from './take-over-task-form';
import { TaskStartupStatus } from './task-startup-status';

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
  const [view, setView] = useMemento(coordinatorViewMemento);
  const { tab } = view;
  const setTab = (tab: typeof view.tab) => setView({ version: '1', tab });
  const composition = useTaskComposition();
  const queryClient = useQueryClient();
  const key = ['coordinator', taskId];
  const { data: record } = useQuery({
    queryKey: key,
    queryFn: async () => (await getCoordinationClient()).getByTask({ taskId }),
  });
  const { navigate } = useNavigate();
  const primaryId = record?.conversationId;
  const primaryType = primaryId
    ? getConversationsForTask(taskId)?.conversations.get(primaryId)?.data.type
    : undefined;
  useEffect(() => {
    if (tab !== 'conversation' || !primaryId || !primaryType) return;
    composition.paneLayout.open(
      primaryType === 'acp' ? 'acp-chat' : 'conversation',
      { conversationId: primaryId },
      { preview: false }
    );
  }, [composition, primaryId, primaryType, tab]);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getCoordinationClient()
      .then(async (client) => {
        const next = await client.events.subscribe(undefined, {
          onEvent: () => {
            void queryClient.invalidateQueries({ queryKey: ['coordinator', taskId] });
            void queryClient.invalidateQueries({ queryKey: ['coordinator-delegation-status'] });
            void queryClient.invalidateQueries({ queryKey: ['task-pull-requests'] });
          },
          onGap: () => {
            void queryClient.invalidateQueries({ queryKey: ['coordinator', taskId] });
            void queryClient.invalidateQueries({ queryKey: ['coordinator-delegation-status'] });
            void queryClient.invalidateQueries({ queryKey: ['task-pull-requests'] });
          },
        });
        if (disposed) next();
        else unsubscribe = next;
      })
      .catch((error) => toast.error('无法订阅主任务工作区更新', { description: String(error) }));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [taskId, queryClient]);
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="coordinator-panel"
      data-task-id={taskId}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button
          data-testid="coordinator-conversation-tab"
          variant={tab === 'conversation' ? 'secondary' : 'ghost'}
          onClick={() => setTab('conversation')}
        >
          对话
        </Button>
        <Button
          data-testid="coordinator-tasks-tab"
          variant={tab === 'tasks' ? 'secondary' : 'ghost'}
          onClick={() => setTab('tasks')}
        >
          概览
        </Button>
        <Button
          data-testid="coordinator-documents-tab"
          variant={tab === 'documents' ? 'secondary' : 'ghost'}
          onClick={() => {
            setTab('documents');
            composition.chrome.commands.openSidebarTab('files');
            const path = composition.editorView.openFilePaths.at(-1);
            if (record && path) void openFileInTaskEditor(record.projectId, taskId, path);
          }}
        >
          文档
        </Button>
        <Button
          data-testid="coordinator-settings-tab"
          variant={tab === 'settings' ? 'secondary' : 'ghost'}
          onClick={() => setTab('settings')}
        >
          设置
        </Button>
      </div>
      {tab === 'documents' ? (
        record ? (
          <CoordinatorDocumentsPanel record={record}>{children}</CoordinatorDocumentsPanel>
        ) : (
          <p className="p-4">正在加载主任务工作区…</p>
        )
      ) : tab === 'conversation' ? (
        <div className="min-h-0 flex-1">{children}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!record ? (
            <p>正在加载主任务工作区…</p>
          ) : tab === 'settings' ? (
            <div className="space-y-6">
              <ProjectAccessSettings record={record} />
              <MainConversationSettings record={record} />
            </div>
          ) : (
            <>
              <WorkspaceOverview
                record={record}
                displayName={
                  record.kind === 'project'
                    ? `${getProjectStore(record.projectId)?.name ?? '项目'} 主任务`
                    : record.name
                }
                onChanged={() => queryClient.invalidateQueries({ queryKey: key })}
              />
              <TakeOverTaskForm record={record} />
              {Object.values(record.tasks).length === 0 && (
                <p className="mt-4 text-sm text-foreground-muted">
                  还没有代码任务。可以继续分析和讨论；需要修改仓库时再创建独立 Emdash Task。
                </p>
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
                    {getProjectStore(task.projectId)?.name ?? '项目不可用'} ·{' '}
                    {taskStateLabel(task.state)}
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
                            toast.error('无法取消任务', { description: String(error) })
                          );
                      }}
                    >
                      取消等待中的任务
                    </Button>
                  )}
                  {task.blockedReason && <p className="mt-2 text-sm">{task.blockedReason}</p>}
                  <TaskStartupStatus
                    coordinatorId={record.id}
                    taskId={task.taskId}
                    cancelled={task.state === 'cancelled'}
                  />
                  {task.taskCreated !== false && <TaskPullRequestStatus taskId={task.taskId} />}
                  {!!task.dependsOn?.length && (
                    <p className="mt-2 text-xs text-foreground-muted">
                      前置任务：{task.dependsOn.join(', ')}
                    </p>
                  )}
                  {!!task.documents?.length && (
                    <details className="mt-2 text-sm" data-testid="assigned-task-documents">
                      <summary>冻结的任务文档（{task.documents.length}）</summary>
                      {task.documents.map((doc, index) => (
                        <details key={index} className="mt-2">
                          <summary>
                            {doc.path} · {doc.revision}
                          </summary>
                          <p className="text-xs text-foreground-muted">来源：{doc.coordinatorId}</p>
                          <pre className="max-h-64 overflow-auto p-2 whitespace-pre-wrap">
                            {doc.content}
                          </pre>
                        </details>
                      ))}
                    </details>
                  )}
                  {task.result && (
                    <div className="mt-2 space-y-2 text-sm">
                      <p className="whitespace-pre-wrap">{task.result.summary}</p>
                      {task.result.checks.map((check, index) => (
                        <p key={index}>
                          {check.passed ? '通过' : '失败'}：<code>{check.command}</code>
                          {check.output && (
                            <span className="block whitespace-pre-wrap">{check.output}</span>
                          )}
                        </p>
                      ))}
                      {task.result.commits.length > 0 && (
                        <p>提交：{task.result.commits.join(', ')}</p>
                      )}
                      {task.result.prUrls.map((url) => (
                        <p key={url}>PR：{url}</p>
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
                      {task.review && <p>验收：{task.review.note}</p>}
                    </div>
                  )}
                </article>
              ))}
              {record.events.some((event) => event.error && event.state === 'pending') && (
                <div className="space-y-2">
                  <p>有结果已保存，正在等待通知 Main Agent。</p>
                  <Button
                    onClick={() => {
                      void getCoordinationClient()
                        .then((client) => client.retryDelivery({ id: record.id }))
                        .catch((error) =>
                          toast.error('无法发送结果通知', { description: String(error) })
                        );
                    }}
                  >
                    重试结果通知
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

const workItemStateLabels = {
  open: '待开始',
  in_progress: '进行中',
  waiting: '等待中',
  review: '待验收',
  done: '已完成',
  deferred: '已推迟',
  cancelled: '已取消',
} as const;

function taskStateLabel(state: AssignedTask['state']) {
  return {
    assigned: '已分配',
    blocked: '受阻',
    cancelled: '已取消',
    review: '待验收',
    changes_requested: '需要修改',
    done: '已完成',
  }[state];
}

function WorkspaceOverview({
  record,
  displayName,
  onChanged,
}: {
  record: Coordinator;
  displayName: string;
  onChanged(): Promise<unknown>;
}) {
  const [title, setTitle] = useState('');
  const [checkpointTitle, setCheckpointTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const tasks = Object.values(record.tasks);
  const attention = tasks.filter((task) =>
    ['blocked', 'review', 'changes_requested'].includes(task.state)
  );
  const nextAction = attention[0]
    ? attention[0].state === 'review'
      ? `验收「${attention[0].name}」的结果`
      : `处理「${attention[0].name}」的${taskStateLabel(attention[0].state)}状态`
    : (Object.values(record.workItems).find((item) => item.state !== 'done')?.title ??
      '继续在对话中明确下一步');
  const mutate = (action: () => Promise<unknown>, success: string) => {
    setSaving(true);
    void action()
      .then(onChanged)
      .then(() => toast.success(success))
      .catch((error) => toast.error('操作失败', { description: String(error) }))
      .finally(() => setSaving(false));
  };
  return (
    <section className="@container mb-6 space-y-4" aria-labelledby="workspace-overview-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="workspace-overview-title" className="text-lg font-medium">
              {displayName}
            </h2>
            <span className="rounded-full bg-background-tertiary-2 px-2 py-0.5 text-xs">
              {record.lifecycle.kind === 'finite' ? '一次性' : '长期'} ·{' '}
              {record.lifecycle.state === 'active'
                ? '进行中'
                : record.lifecycle.state === 'paused'
                  ? '已暂停'
                  : record.lifecycle.state === 'completed'
                    ? '已完成'
                    : '已归档'}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-foreground-muted">
            {record.purpose || '尚未填写工作目标。可以在对话中继续细化。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {record.lifecycle.kind === 'finite' && record.lifecycle.state !== 'completed' && (
            <Button
              disabled={saving}
              onClick={() =>
                mutate(
                  async () =>
                    (await getCoordinationClient()).setLifecycleState({
                      id: record.id,
                      action: 'complete',
                    }),
                  '工作区已完成'
                )
              }
            >
              完成工作区
            </Button>
          )}
          {record.lifecycle.kind === 'ongoing' && record.lifecycle.state === 'active' && (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() =>
                mutate(
                  async () =>
                    (await getCoordinationClient()).setLifecycleState({
                      id: record.id,
                      action: 'pause',
                    }),
                  '工作区已暂停'
                )
              }
            >
              暂停
            </Button>
          )}
          {record.lifecycle.kind === 'ongoing' && record.lifecycle.state === 'paused' && (
            <Button
              disabled={saving}
              onClick={() =>
                mutate(
                  async () =>
                    (await getCoordinationClient()).setLifecycleState({
                      id: record.id,
                      action: 'resume',
                    }),
                  '工作区已恢复'
                )
              }
            >
              恢复
            </Button>
          )}
          {record.lifecycle.state !== 'archived' && (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() =>
                mutate(
                  async () =>
                    (await getCoordinationClient()).setLifecycleState({
                      id: record.id,
                      action: 'archive',
                    }),
                  '工作区已归档'
                )
              }
            >
              归档
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-3 @xl:grid-cols-2">
        <article className="rounded-lg border border-border p-3">
          <h3 className="text-xs font-medium text-foreground-muted">下一步</h3>
          <p className="mt-1 text-sm">{nextAction}</p>
        </article>
        <article className="rounded-lg border border-border p-3">
          <h3 className="text-xs font-medium text-foreground-muted">需要关注</h3>
          <p className="mt-1 text-sm">
            {attention.length ? `${attention.length} 项需要处理` : '当前没有阻塞或待验收事项'}
          </p>
        </article>
      </div>

      <WorkspaceKnowledgeSummary record={record} />

      <section className="space-y-2" aria-labelledby="work-items-title">
        <h3 id="work-items-title" className="font-medium">
          工作事项
        </h3>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            mutate(
              async () =>
                (await getCoordinationClient()).addWorkItem({
                  id: record.id,
                  requestId: crypto.randomUUID(),
                  title: title.trim(),
                }),
              '工作事项已添加'
            );
            setTitle('');
          }}
        >
          <Input
            className="min-w-56 flex-1"
            aria-label="新工作事项标题"
            value={title}
            placeholder="添加结果、分析问题或协调事项"
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" disabled={saving || !title.trim()}>
            添加
          </Button>
        </form>
        {!Object.keys(record.workItems).length && (
          <p className="text-sm text-foreground-muted">还没有工作事项。</p>
        )}
        {Object.values(record.workItems).map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
          >
            <span className="min-w-48 flex-1 text-sm">{item.title}</span>
            <Select.Root
              value={item.state}
              onValueChange={(state) => {
                if (!state) return;
                mutate(
                  async () =>
                    (await getCoordinationClient()).updateWorkItem({
                      id: record.id,
                      workItemId: item.id,
                      state,
                    }),
                  '工作事项已更新'
                );
              }}
            >
              <Select.Trigger aria-label={`更新“${item.title}”的状态`}>
                <Select.Value>{workItemStateLabels[item.state]}</Select.Value>
              </Select.Trigger>
              <Select.Content>
                {Object.entries(workItemStateLabels).map(([value, label]) => (
                  <Select.Item key={value} value={value}>
                    {label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>
        ))}
      </section>

      {record.lifecycle.kind === 'ongoing' && (
        <section className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">阶段检查点</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!checkpointTitle.trim()) return;
              mutate(
                async () =>
                  (await getCoordinationClient()).checkpoint({
                    id: record.id,
                    requestId: crypto.randomUUID(),
                    title: checkpointTitle.trim(),
                  }),
                '阶段检查点已创建'
              );
              setCheckpointTitle('');
            }}
          >
            <Input
              className="min-w-56 flex-1"
              aria-label="阶段检查点标题"
              value={checkpointTitle}
              placeholder="记录本阶段成果和下一步"
              onChange={(event) => setCheckpointTitle(event.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={saving || !checkpointTitle.trim()}>
              创建检查点
            </Button>
          </form>
          {!record.checkpoints.length && (
            <p className="text-xs text-foreground-muted">还没有检查点。</p>
          )}
          {[...record.checkpoints].reverse().map((checkpoint) => (
            <div key={checkpoint.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span>{checkpoint.title}</span>
              <span className="text-foreground-muted">
                {new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.workItemIds.length}{' '}
                个工作事项
              </span>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}

function WorkspaceKnowledgeSummary({ record }: { record: Coordinator }) {
  const queryClient = useQueryClient();
  const linkedProjectIds = useMemo(
    () => record.projectIds.filter((id) => !isMainAgentHostProject(id)),
    [record.projectIds]
  );
  const linkedKey = linkedProjectIds.join(',');
  const queryKey = useMemo(
    () => ['main-agent-knowledge', record.id, linkedKey] as const,
    [linkedKey, record.id]
  );
  const knowledge = useQuery({
    queryKey,
    queryFn: async () => {
      const [requirements, memory] = await Promise.all([
        getRequirementsClient(),
        getMemoryClient(),
      ]);
      const [projects, globalMemory] = await Promise.all([
        Promise.all(
          linkedProjectIds.map(async (projectId) => ({
            projectId,
            name: getProjectStore(projectId)?.name ?? projectId,
            requirements: await requirements.list({ projectId }),
            decisions: await memory.list({ scope: 'project', projectId }),
          }))
        ),
        memory.list({ scope: 'global' }),
      ]);
      return { projects, globalMemory };
    },
  });
  useEffect(() => {
    let disposed = false;
    const unsubscribers: Array<() => void> = [];
    void Promise.all([getRequirementsClient(), getMemoryClient()])
      .then(async ([requirements, memory]) => {
        const requirementSubscription = await requirements.events.subscribe(undefined, {
          onEvent: (event) => {
            if (linkedProjectIds.includes(event.projectId))
              void queryClient.invalidateQueries({ queryKey });
          },
          onGap: () => void queryClient.invalidateQueries({ queryKey }),
        });
        const memorySubscription = await memory.events.subscribe(undefined, {
          onEvent: (event) => {
            if (
              event.scope === 'global' ||
              (event.scope === 'project' && linkedProjectIds.includes(event.projectId))
            )
              void queryClient.invalidateQueries({ queryKey });
          },
          onGap: () => void queryClient.invalidateQueries({ queryKey }),
        });
        if (disposed) {
          requirementSubscription();
          memorySubscription();
        } else {
          unsubscribers.push(requirementSubscription, memorySubscription);
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [linkedProjectIds, queryClient, queryKey]);
  return (
    <section className="space-y-2" aria-labelledby="workspace-knowledge-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="workspace-knowledge-title" className="font-medium">
          项目 TODO、决策与记忆
        </h3>
        <Button type="button" size="sm" variant="ghost" onClick={() => void knowledge.refetch()}>
          刷新上下文
        </Button>
      </div>
      {!linkedProjectIds.length && (
        <p className="text-sm text-foreground-muted">
          还没有关联业务项目。派活到项目后会自动关联，并在这里汇总项目 TODO 与决策。
        </p>
      )}
      {knowledge.isError && (
        <p role="alert" className="text-sm text-foreground-destructive">
          无法加载项目上下文：{String(knowledge.error)}
        </p>
      )}
      <div className="grid gap-3 @xl:grid-cols-2">
        {knowledge.data?.projects.map((project) => {
          const open = project.requirements.filter((item) => item.status === 'open');
          return (
            <article key={project.projectId} className="rounded-lg border border-border p-3">
              <h4 className="text-sm font-medium">{project.name}</h4>
              <p className="mt-1 text-xs text-foreground-muted">
                {open.length} 个待办 · {project.decisions.length} 条项目决策
              </p>
              {open.length > 0 && (
                <ul className="mt-2 list-inside list-disc space-y-1 text-xs">
                  {open.slice(0, 5).map((item) => (
                    <li key={item.id}>{item.title}</li>
                  ))}
                </ul>
              )}
              {project.decisions[0] && (
                <p className="mt-2 text-xs">最新决策：{project.decisions[0].title}</p>
              )}
            </article>
          );
        })}
        <article className="rounded-lg border border-border p-3">
          <h4 className="text-sm font-medium">全局记忆</h4>
          <p className="mt-1 text-xs text-foreground-muted">
            {knowledge.data?.globalMemory.length ?? 0} 条跨项目决策
          </p>
          {knowledge.data?.globalMemory[0] && (
            <p className="mt-2 text-xs">最新记录：{knowledge.data.globalMemory[0].title}</p>
          )}
        </article>
      </div>
    </section>
  );
}

const ProjectAccessSettings = observer(function ProjectAccessSettings({
  record,
}: {
  record: Coordinator;
}) {
  const [access, setAccess] = useState<ProjectAccess>(record.projectAccess ?? { mode: 'all' });
  const [linked, setLinked] = useState(record.projectIds);
  const [saving, setSaving] = useState(false);
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt && !isMainAgentHostProject(project.id)
  );
  return (
    <div className="max-w-lg space-y-3">
      <p className="text-sm font-medium">项目访问与关联</p>
      <Select.Root
        value={access.mode}
        onValueChange={(value) =>
          setAccess(
            value === 'selected' ? { mode: 'selected', projectIds: linked } : { mode: 'all' }
          )
        }
      >
        <Select.Trigger data-testid="coordinator-project-access">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item data-testid="coordinator-access-all" value="all">
            所有可访问的 Emdash 项目
          </Select.Item>
          <Select.Item data-testid="coordinator-access-selected" value="selected">
            仅所选项目
          </Select.Item>
        </Select.Content>
      </Select.Root>
      <p className="text-xs text-foreground-muted">
        关联项目用于组织上下文；允许项目控制发现和派活。Task worker 只获得明确授予的项目访问权。
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
              已关联
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
                允许访问
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
            .then(() => toast.success('项目访问设置已保存'))
            .catch((error) => toast.error('无法保存项目访问设置', { description: String(error) }))
            .finally(() => setSaving(false));
        }}
      >
        保存项目访问设置
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
      <p className="text-sm font-medium">结果通知会话</p>
      <p className="text-xs text-foreground-muted">
        同一主任务工作区中的所有会话都有相同协调权限；这里只决定任务结果自动唤醒哪个会话。
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
          ) && <Select.Item value={record.conversationId}>当前通知会话不可用</Select.Item>}
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
            .then(() => toast.success('结果通知会话已更新'))
            .catch((error) => toast.error('无法更新结果通知会话', { description: String(error) }))
            .finally(() => setSaving(false));
        }}
      >
        设为结果通知会话
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
      toast.error('请说明需要修改的内容。');
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
          note: note.trim() || '用户已在 Emdash 中验收。',
        })
      )
      .then(onReviewed)
      .catch((error) => {
        void onReviewed();
        toast.error('无法提交验收结果', { description: String(error) });
      })
      .finally(() => setSaving(false));
  };
  return (
    <div className="space-y-2">
      <Input
        aria-label="验收意见"
        value={note}
        placeholder="验收意见"
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          data-testid="coordinator-accept-result"
          disabled={saving}
          onClick={() => review(true)}
        >
          接受结果
        </Button>
        <Button variant="secondary" disabled={saving} onClick={() => review(false)}>
          要求修改
        </Button>
      </div>
    </div>
  );
}
