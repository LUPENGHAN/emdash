import {
  Button,
  Combobox,
  ContextMenu,
  Dialog,
  Input,
  Select,
  toast,
} from '@emdash/ui/react/primitives';
import {
  Archive,
  ArchiveRestore,
  Bot,
  CheckCircle2,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useModalController, useOpenModal } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useNavigate, useViewParams } from '@core/primitives/navigation/browser/navigation-hooks';
import { getCoordinationClient } from '../api/browser/client';
import { useCoordinators } from '../api/browser/use-coordinators';
import { isMainAgentHostProject } from '../api/main-agent-host';
import { getCoordinatorActionAvailability, type Coordinator } from '../api/types';

const workspaceFilterLabels = {
  current: '当前工作区',
  finite: '一次性任务',
  ongoing: '长期工作区',
  project: '项目专用',
  completed: '已完成',
  archived: '已归档',
  trash: '废纸篓',
  all: '全部',
} as const;

type WorkspaceFilter = keyof typeof workspaceFilterLabels;

export function CrossProjectMainAgents() {
  const query = useCoordinators();
  const [filter, setFilter] = useState<WorkspaceFilter>('current');
  const records =
    query.data?.filter((record) => {
      if (filter === 'trash') return Boolean(record.deletedAt);
      if (record.deletedAt) return false;
      if (filter === 'all') return true;
      if (filter === 'current') return record.lifecycle.state !== 'archived';
      if (filter === 'finite') return record.lifecycle.kind === 'finite';
      if (filter === 'ongoing') return record.lifecycle.kind === 'ongoing';
      if (filter === 'project') return record.kind === 'project';
      if (filter === 'completed') return record.lifecycle.state === 'completed';
      return record.lifecycle.state === 'archived';
    }) ?? [];
  const { navigate } = useNavigate();
  const active = useViewParams(taskViewDef);
  const [opening, setOpening] = useState<string>();
  const [acting, setActing] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [draftName, setDraftName] = useState('');
  const openConfirm = useOpenModal('confirmActionModal');
  const openPermanentDelete = useOpenModal('deleteMainAgentModal');
  const openCreate = useOpenModal('createMainAgentModal');

  const openWorkspace = (record: Coordinator) => {
    if (record.deletedAt) return;
    setOpening(record.id);
    void getCoordinationClient()
      .then((client) => client.open({ id: record.id }))
      .then(async (opened) => {
        await when(() => !!getTaskManagerStore(opened.projectId), { timeout: 20000 });
        const manager = getTaskManagerStore(opened.projectId);
        if (!manager) throw new Error('主任务工作区的兼容项目不可用。');
        await manager.loadTasks();
        navigate(taskViewDef({ projectId: opened.projectId, taskId: opened.taskId }));
      })
      .catch((error) =>
        toast.error('无法打开主任务工作区', {
          description: String(error),
        })
      )
      .finally(() => setOpening(undefined));
  };

  const runAction = async (
    id: string,
    successMessage: string,
    action: (client: Awaited<ReturnType<typeof getCoordinationClient>>) => Promise<unknown>
  ): Promise<boolean> => {
    setActing(id);
    try {
      await action(await getCoordinationClient());
      await query.refetch();
      toast.success(successMessage);
      return true;
    } catch (error) {
      toast.error('操作失败', { description: String(error) });
      return false;
    } finally {
      setActing(undefined);
    }
  };

  const trashWorkspace = async (record: Coordinator, displayName: string) => {
    const outcome = await openConfirm({
      title: '移到废纸篓？',
      description: `“${displayName}”将从工作区列表移到废纸篓，可随时恢复。关联项目、任务、决策和记忆不会被删除。`,
      confirmLabel: '移到废纸篓',
    });
    if (!outcome.success) return;
    await runAction(record.id, '已移到废纸篓', (client) => client.trash({ id: record.id }));
  };
  const permanentlyDeleteWorkspace = async (record: Coordinator, displayName: string) => {
    const outcome = await openPermanentDelete({ id: record.id, name: displayName });
    if (!outcome.success) return;
    await runAction(record.id, '主任务工作区已永久删除', (client) =>
      client.permanentlyDelete({ id: record.id, options: outcome.data })
    );
  };
  return (
    <section
      className="flex max-h-[50%] min-h-0 shrink-0 flex-col px-2 pb-3"
      data-testid="main-agent-workspaces"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <p className="text-xs font-medium text-foreground-muted">主任务工作区</p>
        <Button
          variant="ghost"
          size="xs"
          aria-label="新建主任务工作区"
          onClick={() => void openCreate({})}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div
        className="min-h-0 [scrollbar-gutter:stable] space-y-1 overflow-y-auto overscroll-contain"
        data-testid="main-agent-workspace-scroll"
      >
        <div className="px-2 pb-1">
          <label
            htmlFor="main-workspace-filter"
            className="mb-1 block text-xs text-foreground-muted"
          >
            显示范围
          </label>
          <Select.Root
            value={filter}
            onValueChange={(value) => value && setFilter(value as typeof filter)}
          >
            <Select.Trigger id="main-workspace-filter" data-testid="main-workspace-filter">
              <Select.Value>{workspaceFilterLabels[filter]}</Select.Value>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="current">当前工作区</Select.Item>
              <Select.Item value="finite">一次性任务</Select.Item>
              <Select.Item value="ongoing">长期工作区</Select.Item>
              <Select.Item value="project">项目专用</Select.Item>
              <Select.Item value="completed">已完成</Select.Item>
              <Select.Item value="archived">已归档</Select.Item>
              <Select.Item value="trash">废纸篓</Select.Item>
              <Select.Item value="all">全部</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        {query.isPending && <p className="px-2 py-2 text-xs text-foreground-muted">正在加载…</p>}
        {query.isError && (
          <p role="alert" className="text-destructive px-2 py-2 text-xs">
            无法加载主任务工作区
          </p>
        )}
        {!query.isPending && !records.length && (
          <p className="px-2 py-2 text-xs text-foreground-muted">此范围内还没有主任务工作区</p>
        )}
        {records.map((record) => {
          const projectName = getProjectManagerStore().projects.get(record.projectId)?.name;
          const displayName =
            record.kind === 'project' && projectName ? `${projectName} 主任务` : record.name;
          const availability = getCoordinatorActionAvailability(record);
          if (editing === record.id) {
            return (
              <form
                key={record.id}
                className="flex min-h-9 items-center gap-1 rounded-lg px-2 py-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAction(record.id, '工作区已重命名', (client) =>
                    client.update({ id: record.id, name: draftName })
                  ).then((succeeded) => {
                    if (succeeded) setEditing(undefined);
                  });
                }}
              >
                <Input
                  autoFocus
                  aria-label="工作区名称"
                  value={draftName}
                  maxLength={100}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(undefined);
                  }}
                />
                <Button
                  type="submit"
                  size="xs"
                  disabled={!draftName.trim() || acting === record.id}
                >
                  保存
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setEditing(undefined)}
                >
                  取消
                </Button>
              </form>
            );
          }
          return (
            <ContextMenu.Root key={record.id}>
              <ContextMenu.Trigger>
                <button
                  type="button"
                  aria-current={active?.taskId === record.taskId ? 'page' : undefined}
                  aria-disabled={record.deletedAt ? true : undefined}
                  disabled={opening === record.id || acting === record.id}
                  className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-background-tertiary-1 disabled:opacity-60 aria-[current=page]:bg-background-tertiary-2"
                  onClick={() => openWorkspace(record)}
                >
                  <Bot className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{displayName}</span>
                    <span className="block truncate text-[11px] text-foreground-muted">
                      {record.lifecycle.kind === 'finite' ? '一次性' : '长期'} ·{' '}
                      {record.deletedAt
                        ? '废纸篓'
                        : record.lifecycle.state === 'active'
                          ? '进行中'
                          : record.lifecycle.state === 'paused'
                            ? '已暂停'
                            : record.lifecycle.state === 'completed'
                              ? '已完成'
                              : record.lifecycle.state === 'archived'
                                ? '已归档'
                                : '待处理'}
                    </span>
                  </span>
                  {Object.values(record.tasks).filter((task) =>
                    ['blocked', 'review', 'changes_requested'].includes(task.state)
                  ).length > 0 && (
                    <span className="rounded-full bg-background-tertiary-2 px-1.5 text-[11px]">
                      {
                        Object.values(record.tasks).filter((task) =>
                          ['blocked', 'review', 'changes_requested'].includes(task.state)
                        ).length
                      }
                    </span>
                  )}
                  <ChevronRight className="size-3.5 shrink-0 text-foreground-muted" />
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Content finalFocus={false}>
                {record.deletedAt ? (
                  <>
                    <ContextMenu.Item
                      onClick={() =>
                        void runAction(record.id, '工作区已恢复', (client) =>
                          client.restoreTrash({ id: record.id })
                        )
                      }
                    >
                      <ArchiveRestore className="size-4" />
                      恢复
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      variant="destructive"
                      onClick={() => void permanentlyDeleteWorkspace(record, displayName)}
                    >
                      <Trash2 className="size-4" />
                      永久删除…
                    </ContextMenu.Item>
                  </>
                ) : (
                  <>
                    <ContextMenu.Item onClick={() => openWorkspace(record)}>
                      <Bot className="size-4" />
                      打开
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      onClick={() => {
                        setDraftName(record.name);
                        setEditing(record.id);
                      }}
                    >
                      <Pencil className="size-4" />
                      重命名
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    {record.lifecycle.kind === 'finite' &&
                      !['completed', 'archived'].includes(record.lifecycle.state) && (
                        <ContextMenu.Item
                          disabled={!availability.completeAndArchive.available}
                          title={availability.completeAndArchive.reason}
                          onClick={() =>
                            void runAction(record.id, '工作区已完成并归档', (client) =>
                              client.completeAndArchive({ id: record.id })
                            )
                          }
                        >
                          <CheckCircle2 className="size-4" />
                          完成并归档
                        </ContextMenu.Item>
                      )}
                    {record.lifecycle.state === 'archived' ? (
                      <ContextMenu.Item
                        onClick={() =>
                          void runAction(record.id, '工作区已恢复', (client) =>
                            client.setLifecycleState({ id: record.id, action: 'restore' })
                          )
                        }
                      >
                        <ArchiveRestore className="size-4" />
                        恢复
                      </ContextMenu.Item>
                    ) : (
                      <ContextMenu.Item
                        onClick={() =>
                          void runAction(record.id, '工作区已归档', (client) =>
                            client.setLifecycleState({ id: record.id, action: 'archive' })
                          )
                        }
                      >
                        <Archive className="size-4" />
                        仅归档
                      </ContextMenu.Item>
                    )}
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      variant="destructive"
                      disabled={!availability.trash.available}
                      title={availability.trash.reason}
                      onClick={() => void trashWorkspace(record, displayName)}
                    >
                      <Trash2 className="size-4" />
                      删除…
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      variant="destructive"
                      onClick={() => void permanentlyDeleteWorkspace(record, displayName)}
                    >
                      <Trash2 className="size-4" />
                      永久删除…
                    </ContextMenu.Item>
                  </>
                )}
              </ContextMenu.Content>
            </ContextMenu.Root>
          );
        })}
      </div>
    </section>
  );
}

export const CreateCrossProjectMainAgent = observer(function CreateCrossProjectMainAgent({
  onCreated,
  onCancel,
}: {
  onCreated?: () => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lifecycleKind, setLifecycleKind] = useState<'finite' | 'ongoing'>('finite');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt && !isMainAgentHostProject(project.id)
  );
  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: project.name || '未命名仓库',
  }));
  const selectedProjects = projectOptions.filter((project) => projectIds.includes(project.value));
  return (
    <form
      data-testid="cross-project-agent-form"
      className={onCancel ? 'space-y-3' : 'mb-2 space-y-2 rounded-lg border border-border p-2'}
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void getCoordinationClient()
          .then((client) =>
            client.createCrossProject({
              id: requestId,
              name,
              purpose,
              lifecycle: { kind: lifecycleKind, state: 'active' },
              projectIds,
            })
          )
          .then(() => {
            toast.success('主任务工作区已创建');
            setName('');
            setPurpose('');
            setRequestId(crypto.randomUUID());
            onCreated?.();
          })
          .catch((error) => toast.error('无法创建主任务工作区', { description: String(error) }))
          .finally(() => setSaving(false));
      }}
    >
      {!onCancel && <p className="text-sm font-medium">新建主任务工作区</p>}
      <label htmlFor="cross-project-agent-name" className="block text-xs text-foreground-muted">
        工作区名称
      </label>
      <Input
        id="cross-project-agent-name"
        data-testid="cross-project-agent-name"
        value={name}
        placeholder="工作区名称"
        autoFocus={Boolean(onCancel)}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor="cross-project-agent-purpose" className="block text-xs text-foreground-muted">
        工作目标
      </label>
      <Input
        id="cross-project-agent-purpose"
        value={purpose}
        placeholder="这项工作要实现什么？"
        onChange={(event) => setPurpose(event.target.value)}
      />
      <label
        htmlFor="cross-project-agent-lifecycle"
        className="block text-xs text-foreground-muted"
      >
        工作区生命周期
      </label>
      <Select.Root
        value={lifecycleKind}
        onValueChange={(value) => {
          if (value === 'finite' || value === 'ongoing') setLifecycleKind(value);
        }}
      >
        <Select.Trigger id="cross-project-agent-lifecycle">
          <Select.Value>{lifecycleKind === 'finite' ? '一次性任务' : '长期工作区'}</Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="finite">一次性任务</Select.Item>
          <Select.Item value="ongoing">长期工作区</Select.Item>
        </Select.Content>
      </Select.Root>
      <p className="text-xs text-foreground-muted">
        创建工作区不会启动 Agent；Agent 由实际打开的对话会话按需加载。
      </p>
      <label htmlFor="cross-project-agent-projects" className="block text-xs text-foreground-muted">
        关联仓库
      </label>
      <p className="text-xs text-foreground-muted">
        可先不关联；需要修改仓库时再加入。这里的选择只影响工作上下文。
      </p>
      {projects.length > 0 && (
        <Combobox.Root
          items={projectOptions}
          multiple
          value={selectedProjects}
          onValueChange={(nextProjects) =>
            setProjectIds(nextProjects.map((project) => project.value))
          }
          isItemEqualToValue={(project, selected) => project.value === selected.value}
          filter={(project, query) =>
            project.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
          }
        >
          <Combobox.Chips id="cross-project-agent-projects" aria-label="搜索并选择关联仓库">
            {selectedProjects.map((project) => (
              <Combobox.Chip key={project.value}>{project.label}</Combobox.Chip>
            ))}
            <Combobox.ChipsInput placeholder="搜索仓库并选择…" />
          </Combobox.Chips>
          <Combobox.Content className="min-w-(--anchor-width)">
            <Combobox.List>
              <Combobox.Collection>
                {(project: (typeof projectOptions)[number]) => (
                  <Combobox.Item key={project.value} value={project}>
                    <span className="min-w-0 truncate">{project.label}</span>
                  </Combobox.Item>
                )}
              </Combobox.Collection>
              <Combobox.Empty>没有匹配的仓库</Combobox.Empty>
            </Combobox.List>
          </Combobox.Content>
        </Combobox.Root>
      )}
      <div className={onCancel ? 'flex justify-end gap-2 pt-2' : undefined}>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            取消
          </Button>
        )}
        <Button
          data-testid="create-cross-project-agent"
          type="submit"
          disabled={saving || !name.trim()}
        >
          {saving ? '正在创建…' : '创建工作区'}
        </Button>
      </div>
      {!projects.length && (
        <p className="text-xs text-foreground-muted">
          当前没有业务项目，仍可创建主任务；需要修改仓库时再关联或导入项目。
        </p>
      )}
    </form>
  );
});

function CreateMainAgentModal() {
  const { complete, dismiss } = useModalController('createMainAgentModal');
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>新建主任务工作区</Dialog.Title>
        <Dialog.Description>创建任务驱动的工作区，并按需关联一个或多个仓库。</Dialog.Description>
      </Dialog.Header>
      <Dialog.Body className="pt-0">
        <CreateCrossProjectMainAgent onCreated={() => complete(undefined)} onCancel={dismiss} />
      </Dialog.Body>
    </>
  );
}

export const createMainAgentModal = defineModal<void>()({
  id: 'createMainAgentModal',
  component: CreateMainAgentModal,
  size: 'sm',
});
