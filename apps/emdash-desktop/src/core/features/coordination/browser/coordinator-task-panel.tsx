import {
  Button,
  Checkbox,
  Combobox,
  Input,
  Select,
  Sheet,
  Textarea,
  toast,
} from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, LayoutDashboard, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { sendToConversation } from '@core/features/conversations/api/browser/send-to-conversation';
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
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { useMemento } from '@core/primitives/mementos/react';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { getCoordinationClient } from '../api/browser/client';
import { isMainAgentHostProject } from '../api/main-agent-host';
import type { OptimizationRun, OptimizationRunState } from '../api/optimization';
import type {
  AssignedTask,
  Coordinator,
  ProjectAccess,
  WorkspaceCompletionReport,
  WorkspaceProjectImport,
} from '../api/types';
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
  const tab = view.tab === 'settings' ? 'tasks' : view.tab;
  const setTab = (tab: typeof view.tab) => setView({ version: '1', tab });
  const composition = useTaskComposition();
  const queryClient = useQueryClient();
  const key = ['coordinator', taskId];
  const { data: record } = useQuery({
    queryKey: key,
    queryFn: async () => (await getCoordinationClient()).getByTask({ taskId }),
  });
  const { navigate } = useNavigate();
  const [titlebarSlot, setTitlebarSlot] = useState<Element | null>(null);
  useEffect(() => {
    const connect = () => {
      const slot = document.querySelector('[data-coordinator-view-switcher-slot]');
      if (!slot) return false;
      setTitlebarSlot(slot);
      return true;
    };
    if (connect()) return;
    const observer = new MutationObserver(() => {
      if (connect()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
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
      {titlebarSlot &&
        createPortal(
          <CoordinatorViewSwitcher
            tab={tab}
            onSelect={(next) => {
              setTab(next);
              if (next !== 'documents') return;
              composition.chrome.commands.openSidebarTab('files');
              const path = composition.editorView.openFilePaths.at(-1);
              if (record && path) void openFileInTaskEditor(record.projectId, taskId, path);
            }}
          />,
          titlebarSlot
        )}
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
              <section className="my-5 max-w-2xl space-y-5 rounded-lg border border-border p-4">
                <h2 className="text-sm font-medium">工作区设置</h2>
                <ProjectAccessSettings record={record} />
                <ResultNotificationSettings record={record} />
                <details>
                  <summary className="cursor-pointer text-sm text-foreground-muted">
                    高级设置
                  </summary>
                  <div className="mt-4">
                    <WorkspaceMigrationSettings record={record} />
                  </div>
                </details>
              </section>
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
                  <p>有结果已保存，正在等待通知工作区的结果通知会话。</p>
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

function CoordinatorViewSwitcher({
  tab,
  onSelect,
}: {
  tab: 'conversation' | 'tasks' | 'documents';
  onSelect(tab: 'conversation' | 'tasks' | 'documents'): void;
}) {
  return (
    <div
      role="group"
      aria-label="主任务工作区视图"
      className="flex items-center gap-0.5 rounded-md bg-background-tertiary-1 p-0.5"
      data-testid="coordinator-view-switcher"
    >
      <Button
        type="button"
        size="xs"
        variant={tab === 'tasks' ? 'secondary' : 'ghost'}
        aria-pressed={tab === 'tasks'}
        data-testid="coordinator-tasks-tab"
        onClick={() => onSelect('tasks')}
      >
        <LayoutDashboard className="size-3.5" />
        概览
      </Button>
      <Button
        type="button"
        size="xs"
        variant={tab === 'conversation' ? 'secondary' : 'ghost'}
        aria-pressed={tab === 'conversation'}
        data-testid="coordinator-conversation-tab"
        onClick={() => onSelect('conversation')}
      >
        <MessageSquare className="size-3.5" />
        对话
      </Button>
      <Button
        type="button"
        size="xs"
        variant={tab === 'documents' ? 'secondary' : 'ghost'}
        aria-pressed={tab === 'documents'}
        data-testid="coordinator-documents-tab"
        onClick={() => onSelect('documents')}
      >
        <FileText className="size-3.5" />
        文档
      </Button>
    </div>
  );
}

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

function projectImportStateLabel(state: WorkspaceProjectImport['state']) {
  return {
    cloning: '正在克隆',
    registering: '正在注册项目',
    ready: '已导入并关联',
    failed: '导入失败',
    cancelled: '已取消',
  }[state];
}

function CompletionReport({ report }: { report: WorkspaceCompletionReport }) {
  return (
    <details className="rounded-lg border border-border p-3" data-testid="completion-report">
      <summary className="cursor-pointer font-medium">完成报告</summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="whitespace-pre-wrap">{report.summary}</p>
        <p className="text-xs text-foreground-muted">
          生成于 {new Date(report.generatedAt).toLocaleString()} · {report.linkedProjectIds.length}{' '}
          个关联项目
        </p>
        <p>
          工作事项：共 {report.workItems.total}，完成 {report.workItems.done}，推迟{' '}
          {report.workItems.deferred}，取消 {report.workItems.cancelled}
        </p>
        {report.tasks.map((task) => (
          <details key={task.taskId} className="rounded border border-border p-2">
            <summary className="cursor-pointer">
              {task.name} · {taskStateLabel(task.state as AssignedTask['state'])}
            </summary>
            <div className="mt-2 space-y-1">
              {task.summary && <p className="whitespace-pre-wrap">{task.summary}</p>}
              {!!task.commits.length && <p>提交：{task.commits.join(', ')}</p>}
              {task.checks.map((check, index) => (
                <p key={index}>
                  {check.passed ? '通过' : '失败'}：{check.command}
                </p>
              ))}
              {task.prUrls.map((url) => (
                <p key={url}>PR：{url}</p>
              ))}
              {task.unresolved.map((issue, index) => (
                <p key={index}>未解决：{issue}</p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
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
          {record.lifecycle.state === 'archived' && !record.supersededById && (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() =>
                mutate(
                  async () =>
                    (await getCoordinationClient()).setLifecycleState({
                      id: record.id,
                      action: 'restore',
                    }),
                  '工作区已恢复'
                )
              }
            >
              恢复工作区
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

      {!!Object.keys(record.projectImports ?? {}).length && (
        <section className="space-y-2" aria-labelledby="project-imports-title">
          <h3 id="project-imports-title" className="font-medium">
            仓库导入
          </h3>
          {Object.values(record.projectImports ?? {}).map((item) => (
            <article key={item.requestId} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{item.name}</span>
                <span>{projectImportStateLabel(item.state)}</span>
              </div>
              <p className="mt-1 text-xs break-all text-foreground-muted">{item.repositoryUrl}</p>
              <p className="mt-1 text-xs text-foreground-muted">目标目录：{item.directory}</p>
              {['cloning', 'registering'].includes(item.state) && (
                <progress
                  className="mt-2 w-full accent-current"
                  max={100}
                  value={item.progress}
                  aria-label={`${item.name} 导入进度`}
                />
              )}
              {item.error && (
                <p role="status" className="mt-2 text-xs">
                  {item.error}
                </p>
              )}
              {['failed', 'cancelled'].includes(item.state) && (
                <p className="mt-2 text-xs text-foreground-muted">
                  工作区中的任意对话可使用相同 request_id 调用
                  retry_project_import；URL、名称和目录会保持不变。
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      {record.completionReport && <CompletionReport report={record.completionReport} />}

      <WorkspaceOptimizations record={record} onChanged={onChanged} />

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

const optimizationStateLabels: Record<OptimizationRunState, string> = {
  captured: '已记录',
  investigating: '调查中',
  planning: '制定方案',
  waiting_for_approval: '等待确认',
  implementing: '实施中',
  validating: '自动验证',
  ready_to_apply: '等待应用',
  applying: '正在应用',
  observing: '等待体验确认',
  accepted: '符合预期',
  blocked: '受阻',
  failed: '验证失败',
  rolled_back: '已回退',
};

function WorkspaceOptimizations({
  record,
  onChanged,
}: {
  record: Coordinator;
  onChanged(): Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState('');
  const [executionMode, setExecutionMode] = useState<'automatic' | 'proposal-first'>('automatic');
  const [experienceConfirmation, setExperienceConfirmation] = useState<
    'user' | 'acceptance-criteria'
  >('user');
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [saving, setSaving] = useState(false);
  const runs = Object.values(record.optimizationRuns).sort((a, b) => b.updatedAt - a.updatedAt);
  const suggestions = Object.values(record.optimizationSuggestions)
    .filter((suggestion) => suggestion.state === 'new')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const appVersion = getUpdateStore().currentVersion;
  const liveEnv = (
    import.meta as ImportMeta & {
      env?: { VITE_BUILD?: string; VITE_LIVE_REVISION?: string };
    }
  ).env;
  const liveRevision = liveEnv?.VITE_BUILD === 'live' ? liveEnv.VITE_LIVE_REVISION : undefined;

  const refresh = async () => {
    await onChanged();
  };
  const mutate = (action: () => Promise<unknown>, success: string) => {
    setSaving(true);
    void action()
      .then(refresh)
      .then(() => toast.success(success))
      .catch((error) => toast.error('操作失败', { description: String(error) }))
      .finally(() => setSaving(false));
  };
  const createRun = (suggestionId?: string, suggestionProblem?: string) => {
    const observedProblem = (suggestionProblem ?? problem).trim();
    if (!observedProblem) return;
    const requestId = crypto.randomUUID();
    mutate(
      async () => {
        const host = await getHostClient();
        const [screenshot, diagnostics] = await Promise.all([
          includeScreenshot ? host.captureCurrentWindow(undefined) : undefined,
          includeLogs ? host.getDiagnosticLogAttachment(undefined) : undefined,
        ]);
        if (screenshot && !screenshot.success) throw new Error(screenshot.error);
        let diagnosticRef: string | undefined;
        if (diagnostics) {
          const saved = await host.persistDroppedBlob({
            bytes: new TextEncoder().encode(diagnostics.content),
            name: diagnostics.filename,
            mimeType: diagnostics.mimeType,
          });
          if (!saved.success) throw new Error(saved.error);
          diagnosticRef = saved.path;
        }
        await (
          await getCoordinationClient()
        ).createOptimizationRun({
          id: record.id,
          requestId,
          conversationId: record.conversationId,
          ...(suggestionId && { suggestionId }),
          executionMode,
          experienceConfirmation,
          objective: observedProblem.split('\n', 1)[0]!.slice(0, 200),
          observedProblem,
          capturedContext: {
            surface: 'main-agent-overview',
            route: globalThis.location?.hash || globalThis.location?.pathname || undefined,
            selectedEntityRefs: [`main-agent:${record.id}`],
            ...(screenshot?.success && { screenshotRef: screenshot.path }),
            logRefs: diagnosticRef ? [diagnosticRef] : [],
          },
          baseline: {
            ...(liveRevision && { liveRevision }),
            appVersion,
          },
          risk: { level: 'low', reasons: [], requiresUserConfirmation: false },
        });
        const manager = getConversationsForTask(record.taskId);
        const conversation = manager?.conversations.get(record.conversationId)?.data;
        if (!manager || !conversation) {
          toast.info('优化已保存，打开结果通知会话后即可继续。');
          return;
        }
        await sendToConversation(
          manager,
          conversation,
          [
            `用户刚刚手动触发体验优化（run_id: ${requestId}）。`,
            `问题：${observedProblem}`,
            executionMode === 'proposal-first'
              ? '请先调查并给出方案，等待用户确认后再实施。'
              : '请自行调查、实施和验证；高风险操作仍必须先征得用户确认。',
            '请通过 Emdash 优化状态工具持续更新进度，代码工作必须创建独立 Task/worktree。',
          ].join('\n')
        );
      },
      suggestionId ? '优化建议已交给主任务工作区' : '体验优化已创建'
    );
    setProblem('');
    setOpen(false);
  };

  return (
    <section className="space-y-3" aria-labelledby="workspace-optimizations-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="workspace-optimizations-title" className="font-medium">
            体验优化
          </h3>
          <p className="text-xs text-foreground-muted">
            由你手动触发，主任务工作区中的对话负责调查、实施、验证并应用到实时开发版。
          </p>
        </div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          交给工作区优化
        </Button>
      </div>

      {runs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-sm text-foreground-muted">
          还没有体验优化。发现不好用的地方时，可以直接交给主任务工作区处理。
        </p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <OptimizationRunCard
              key={run.id}
              recordId={record.id}
              run={run}
              saving={saving}
              mutate={mutate}
            />
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <section
          className="space-y-2 rounded-lg border border-border p-3"
          aria-labelledby="optimization-suggestions-title"
        >
          <h4 id="optimization-suggestions-title" className="text-sm font-medium">
            优化建议
          </h4>
          <p className="text-xs text-foreground-muted">
            建议只记录本地可解释证据；接受前不会创建 TODO 或执行修改。
          </p>
          {suggestions.map((suggestion) => (
            <article key={suggestion.id} className="rounded-md bg-background-tertiary-2 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h5 className="text-sm font-medium">{suggestion.title}</h5>
                  <p className="mt-1 text-xs text-foreground-muted">{suggestion.observedPattern}</p>
                  <p className="mt-1 text-xs">期望结果：{suggestion.proposedOutcome}</p>
                </div>
                <span className="text-xs text-foreground-muted">
                  置信度：
                  {suggestion.confidence === 'high'
                    ? '高'
                    : suggestion.confidence === 'medium'
                      ? '中'
                      : '低'}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => createRun(suggestion.id, suggestion.proposedOutcome)}
                >
                  交给工作区处理
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() =>
                    mutate(
                      async () =>
                        (await getCoordinationClient()).updateOptimizationSuggestion({
                          id: record.id,
                          suggestionId: suggestion.id,
                          state: 'dismissed',
                        }),
                      '建议已关闭'
                    )
                  }
                >
                  不再处理
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}

      <Sheet.Root open={open} onOpenChange={setOpen}>
        <Sheet.Content side="right" className="gap-0 p-0">
          <Sheet.Header showCloseButton={false}>
            <div>
              <Sheet.Title>交给主任务工作区优化</Sheet.Title>
              <p className="mt-1 text-xs text-foreground-muted">
                描述哪里不好用，或者希望达到什么结果。
              </p>
            </div>
            <Sheet.Close render={<Button variant="ghost" size="sm" />}>关闭</Sheet.Close>
          </Sheet.Header>
          <Sheet.Body className="space-y-5">
            <label className="block space-y-2 text-sm">
              <span className="font-medium">体验问题</span>
              <Textarea
                autoFocus
                required
                value={problem}
                onChange={(event) => setProblem(event.target.value)}
                placeholder="例如：任务页面分不清主任务和执行任务，请自己分析并改好。"
                rows={6}
              />
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">执行方式</legend>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={executionMode === 'automatic' ? 'secondary' : 'ghost'}
                  aria-pressed={executionMode === 'automatic'}
                  onClick={() => setExecutionMode('automatic')}
                >
                  自动完成
                </Button>
                <Button
                  type="button"
                  variant={executionMode === 'proposal-first' ? 'secondary' : 'ghost'}
                  aria-pressed={executionMode === 'proposal-first'}
                  onClick={() => setExecutionMode('proposal-first')}
                >
                  先给我方案
                </Button>
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">最终确认</legend>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={experienceConfirmation === 'user' ? 'secondary' : 'ghost'}
                  aria-pressed={experienceConfirmation === 'user'}
                  onClick={() => setExperienceConfirmation('user')}
                >
                  我体验后确认
                </Button>
                <Button
                  type="button"
                  variant={experienceConfirmation === 'acceptance-criteria' ? 'secondary' : 'ghost'}
                  aria-pressed={experienceConfirmation === 'acceptance-criteria'}
                  onClick={() => setExperienceConfirmation('acceptance-criteria')}
                >
                  满足验收标准后自动确认
                </Button>
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">附加信息</legend>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={includeScreenshot} onCheckedChange={setIncludeScreenshot} />
                当前页面截图
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={includeLogs} onCheckedChange={setIncludeLogs} />
                最近相关日志
              </label>
              <p className="text-xs text-foreground-muted">
                不会自动附加完整聊天、密钥、剪贴板、全量日志或无关项目内容。
              </p>
            </fieldset>
          </Sheet.Body>
          <Sheet.Footer>
            <Sheet.Close render={<Button variant="secondary" />}>取消</Sheet.Close>
            <Button disabled={saving || !problem.trim()} onClick={() => createRun()}>
              交给工作区
            </Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet.Root>
    </section>
  );
}

function OptimizationRunCard({
  recordId,
  run,
  saving,
  mutate,
}: {
  recordId: string;
  run: OptimizationRun;
  saving: boolean;
  mutate(action: () => Promise<unknown>, success: string): void;
}) {
  const transition = (
    state: OptimizationRunState,
    success: string,
    extra?: {
      technicalValidationPassed?: boolean;
      userDecision?: 'pending' | 'accepted' | 'continue' | 'rollback';
    }
  ) =>
    mutate(
      async () =>
        (await getCoordinationClient()).transitionOptimizationRun({
          id: recordId,
          runId: run.id,
          state,
          ...extra,
        }),
      success
    );
  return (
    <article className="rounded-lg border border-border p-3" data-optimization-run-id={run.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium">{run.objective}</h4>
          <p className="mt-1 text-xs text-foreground-muted">{run.observedProblem}</p>
        </div>
        <span className="rounded-full bg-background-tertiary-2 px-2 py-1 text-xs">
          {optimizationStateLabels[run.state]}
        </span>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-foreground-muted @md:grid-cols-3">
        <span>
          风险：{run.risk.level === 'high' ? '高' : run.risk.level === 'medium' ? '中' : '低'}
        </span>
        <span>任务：{run.taskIds.length}</span>
        <span>基线：{run.baseline.liveRevision ?? run.baseline.appVersion}</span>
      </div>
      <ol className="mt-3 flex flex-wrap gap-1 text-xs" aria-label="优化进度">
        {run.stateHistory.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="rounded bg-background-tertiary-2 px-2 py-1">
            {optimizationStateLabels[entry.state]}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        {run.state === 'captured' && (
          <Button
            size="sm"
            disabled={saving}
            onClick={() => transition('investigating', '已开始调查')}
          >
            开始调查
          </Button>
        )}
        {run.state === 'waiting_for_approval' && (
          <Button
            size="sm"
            disabled={saving}
            onClick={() => transition('implementing', '已确认实施')}
          >
            确认实施
          </Button>
        )}
        {run.state === 'observing' && (
          <>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => transition('accepted', '体验优化已完成', { userDecision: 'accepted' })}
            >
              符合预期
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() =>
                transition('implementing', '继续原任务调整', { userDecision: 'continue' })
              }
            >
              继续调整
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() =>
                transition('rolled_back', '已回退到上一个可用版本', { userDecision: 'rollback' })
              }
            >
              立即回退
            </Button>
          </>
        )}
      </div>
    </article>
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
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer">查看完整上下文</summary>
                <div className="mt-2 space-y-3">
                  <div>
                    <p className="font-medium">全部 TODO（{project.requirements.length}）</p>
                    {!project.requirements.length && <p className="text-foreground-muted">暂无</p>}
                    <ul className="mt-1 space-y-2">
                      {project.requirements.map((item) => (
                        <li key={item.id}>
                          <p>
                            {item.status === 'done' ? '已完成' : '待办'} · {item.title}
                          </p>
                          {item.detail && (
                            <p className="whitespace-pre-wrap text-foreground-muted">
                              {item.detail}
                            </p>
                          )}
                          <p className="text-foreground-muted">
                            来源：{memorySourceLabel(item.source)} · 更新于{' '}
                            {new Date(item.updatedAt).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium">全部项目决策（{project.decisions.length}）</p>
                    {!project.decisions.length && <p className="text-foreground-muted">暂无</p>}
                    <ul className="mt-1 space-y-2">
                      {project.decisions.map((item) => (
                        <li key={item.id}>
                          <p>{item.title}</p>
                          {item.detail && (
                            <p className="whitespace-pre-wrap text-foreground-muted">
                              {item.detail}
                            </p>
                          )}
                          <p className="text-foreground-muted">
                            来源：{memorySourceLabel(item.source)} · 更新于{' '}
                            {new Date(item.updatedAt).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </details>
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
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer">查看完整全局记忆</summary>
            <ul className="mt-2 space-y-2">
              {knowledge.data?.globalMemory.map((item) => (
                <li key={item.id}>
                  <p>{item.title}</p>
                  {item.detail && (
                    <p className="whitespace-pre-wrap text-foreground-muted">{item.detail}</p>
                  )}
                  <p className="text-foreground-muted">
                    来源：{memorySourceLabel(item.source)} · 更新于{' '}
                    {new Date(item.updatedAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        </article>
      </div>
    </section>
  );
}

function memorySourceLabel(source: { kind: string; providerId?: string }) {
  return source.kind === 'user'
    ? '用户'
    : `Agent${source.providerId ? `（${source.providerId}）` : ''}`;
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
  const options = projects.map((project) => ({
    value: project.id,
    label: project.name || '未命名仓库',
  }));
  const selectedLinked = options.filter((project) => linked.includes(project.value));
  const selectedAccess =
    access.mode === 'selected'
      ? options.filter((project) => access.projectIds.includes(project.value))
      : [];
  return (
    <div className="max-w-lg space-y-3">
      <p className="text-sm font-medium">关联仓库</p>
      <p className="text-xs text-foreground-muted">
        搜索并选择这项工作涉及的仓库。打开工作区不会启动 Agent。
      </p>
      <Combobox.Root
        items={options}
        multiple
        value={selectedLinked}
        onValueChange={(next) => setLinked(next.map((project) => project.value))}
        isItemEqualToValue={(project, selected) => project.value === selected.value}
        filter={(project, query) =>
          project.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
        }
      >
        <Combobox.Chips aria-label="搜索并选择关联仓库" data-testid="coordinator-linked-projects">
          {selectedLinked.map((project) => (
            <Combobox.Chip key={project.value}>{project.label}</Combobox.Chip>
          ))}
          <Combobox.ChipsInput placeholder="搜索仓库并选择…" />
        </Combobox.Chips>
        <Combobox.Content className="min-w-(--anchor-width)">
          <Combobox.List>
            <Combobox.Collection>
              {(project: (typeof options)[number]) => (
                <Combobox.Item key={project.value} value={project}>
                  {project.label}
                </Combobox.Item>
              )}
            </Combobox.Collection>
            <Combobox.Empty>没有匹配的仓库</Combobox.Empty>
          </Combobox.List>
        </Combobox.Content>
      </Combobox.Root>
      <details>
        <summary className="cursor-pointer text-xs text-foreground-muted">仓库访问权限</summary>
        <div className="mt-3 space-y-3">
          <Select.Root
            value={access.mode}
            onValueChange={(value) =>
              setAccess(
                value === 'selected' ? { mode: 'selected', projectIds: linked } : { mode: 'all' }
              )
            }
          >
            <Select.Trigger data-testid="coordinator-project-access">
              <Select.Value>
                {access.mode === 'all' ? '所有可访问的 Emdash 项目' : '仅所选项目'}
              </Select.Value>
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
          {access.mode === 'selected' && (
            <Combobox.Root
              items={options}
              multiple
              value={selectedAccess}
              onValueChange={(next) =>
                setAccess({ mode: 'selected', projectIds: next.map((project) => project.value) })
              }
              isItemEqualToValue={(project, selected) => project.value === selected.value}
              filter={(project, query) =>
                project.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
              }
            >
              <Combobox.Chips aria-label="搜索并选择允许访问的仓库">
                {selectedAccess.map((project) => (
                  <Combobox.Chip key={project.value}>{project.label}</Combobox.Chip>
                ))}
                <Combobox.ChipsInput placeholder="搜索允许访问的仓库…" />
              </Combobox.Chips>
              <Combobox.Content className="min-w-(--anchor-width)">
                <Combobox.List>
                  <Combobox.Collection>
                    {(project: (typeof options)[number]) => (
                      <Combobox.Item key={project.value} value={project}>
                        {project.label}
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                  <Combobox.Empty>没有匹配的仓库</Combobox.Empty>
                </Combobox.List>
              </Combobox.Content>
            </Combobox.Root>
          )}
          <p className="text-xs text-foreground-muted">
            执行任务仍只获得下发时明确授予的仓库权限。
          </p>
        </div>
      </details>
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

function WorkspaceMigrationSettings({ record }: { record: Coordinator }) {
  const [saving, setSaving] = useState(false);
  const standalone = isMainAgentHostProject(record.projectId);
  if (standalone && !record.migratedFromId) return null;
  return (
    <section className="max-w-lg space-y-3" aria-labelledby="workspace-migration-title">
      <h3 id="workspace-migration-title" className="text-sm font-medium">
        工作区存储位置
      </h3>
      {!standalone ? (
        <>
          <p className="text-xs text-foreground-muted">
            该旧工作区仍绑定业务仓库。迁移会在 Emdash
            内部管理仓库创建一个独立工作区，复制目标、工作事项、检查点和项目关联；旧任务与对话保留在原工作区并归档，不会移动分支或删除历史。
          </p>
          <Button
            disabled={saving || !!record.supersededById}
            onClick={() => {
              setSaving(true);
              void getCoordinationClient()
                .then((client) =>
                  client.migrateToStandalone({ id: record.id, requestId: crypto.randomUUID() })
                )
                .then(() => toast.success('迁移已完成，请从顶部列表打开新的独立工作区'))
                .catch((error) => toast.error('无法迁移工作区', { description: String(error) }))
                .finally(() => setSaving(false));
            }}
          >
            {record.supersededById ? '已迁移到独立工作区' : '迁移到独立主任务仓库'}
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-foreground-muted">
            此工作区由旧的项目绑定工作区迁移而来。回滚会恢复旧工作区，并将当前工作区归档；当前工作区中新增的数据仍保留在归档记录中。
          </p>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void getCoordinationClient()
                .then((client) => client.rollbackStandaloneMigration({ id: record.id }))
                .then(() => toast.success('迁移已回滚，旧工作区已恢复'))
                .catch((error) => toast.error('无法回滚迁移', { description: String(error) }))
                .finally(() => setSaving(false));
            }}
          >
            回滚迁移
          </Button>
        </>
      )}
    </section>
  );
}

const ResultNotificationSettings = observer(function ResultNotificationSettings({
  record,
}: {
  record: Coordinator;
}) {
  const [policy, setPolicy] = useState(record.resultRoutingPolicy ?? 'origin-auto');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setPolicy(record.resultRoutingPolicy ?? 'origin-auto');
  }, [record.resultRoutingPolicy]);
  return (
    <div className="max-w-lg space-y-3">
      <p className="text-sm font-medium">任务结果通知</p>
      <p className="text-xs text-foreground-muted">
        下发任务时会固定它的返回位置，不会把结果发给工作区里的其他对话。手动接管或来源不可用的任务会回到工作区收件箱。
      </p>
      <Select.Root
        value={policy}
        onValueChange={(value) => {
          if (value === 'origin-auto' || value === 'origin-notify' || value === 'workspace') {
            setPolicy(value);
          }
        }}
      >
        <Select.Trigger data-testid="coordinator-result-routing-policy">
          <Select.Value>
            {policy === 'origin-auto'
              ? '返回下发对话并自动继续'
              : policy === 'origin-notify'
                ? '返回下发对话，仅通知'
                : '只进入工作区收件箱'}
          </Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="origin-auto">返回下发对话并自动继续</Select.Item>
          <Select.Item value="origin-notify">返回下发对话，仅通知</Select.Item>
          <Select.Item value="workspace">只进入工作区收件箱</Select.Item>
        </Select.Content>
      </Select.Root>
      <Button
        data-testid="coordinator-save-result-routing"
        disabled={saving || policy === (record.resultRoutingPolicy ?? 'origin-auto')}
        onClick={() => {
          setSaving(true);
          void getCoordinationClient()
            .then((client) => client.updateResultRoutingPolicy({ id: record.id, policy }))
            .then(() => toast.success('任务结果通知方式已保存'))
            .catch((error) => toast.error('无法更新结果通知', { description: String(error) }))
            .finally(() => setSaving(false));
        }}
      >
        保存通知方式
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
