import { Button, Input, Select, toast } from '@emdash/ui/react/primitives';
import { Bot, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { PROVIDER_CAPABLE_AGENTS } from '@core/features/model-providers/api';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useNavigate, useViewParams } from '@core/primitives/navigation/browser/navigation-hooks';
import { getCoordinationClient } from '../api/browser/client';
import { useCoordinators } from '../api/browser/use-coordinators';
import { isMainAgentHostProject } from '../api/main-agent-host';

const workspaceFilterLabels = {
  current: '当前工作区',
  finite: '一次性任务',
  ongoing: '长期工作区',
  project: '项目专用',
  completed: '已完成',
  archived: '已归档',
  all: '全部',
} as const;

export function CrossProjectMainAgents() {
  const query = useCoordinators();
  const [filter, setFilter] = useState<
    'current' | 'finite' | 'ongoing' | 'project' | 'completed' | 'archived' | 'all'
  >('current');
  const records =
    query.data?.filter((record) => {
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
  const [creating, setCreating] = useState(false);
  return (
    <section className="space-y-1 px-2 pb-3" data-testid="main-agent-workspaces">
      <div className="flex items-center justify-between px-2 py-1">
        <p className="text-xs font-medium text-foreground-muted">主任务工作区</p>
        <Button
          variant="ghost"
          size="xs"
          aria-label={creating ? '收起新建主任务工作区' : '新建主任务工作区'}
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? <ChevronDown className="size-4" /> : <Plus className="size-4" />}
        </Button>
      </div>
      {creating && <CreateCrossProjectMainAgent onCreated={() => setCreating(false)} />}
      <div className="px-2 pb-1">
        <label htmlFor="main-workspace-filter" className="mb-1 block text-xs text-foreground-muted">
          显示范围
        </label>
        <Select.Root value={filter} onValueChange={(value) => value && setFilter(value as typeof filter)}>
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
      {!query.isPending && !records.length && !creating && (
        <p className="px-2 py-2 text-xs text-foreground-muted">此范围内还没有主任务工作区</p>
      )}
      {records.map((record) => {
        const projectName = getProjectManagerStore().projects.get(record.projectId)?.name;
        const displayName =
          record.kind === 'project' && projectName ? `${projectName} 主任务` : record.name;
        return (
          <button
            key={record.id}
            type="button"
            aria-current={active?.taskId === record.taskId ? 'page' : undefined}
            disabled={opening === record.id}
            className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-background-tertiary-1 aria-[current=page]:bg-background-tertiary-2"
            onClick={() => {
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
            }}
          >
            <Bot className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{displayName}</span>
              <span className="block truncate text-[11px] text-foreground-muted">
                {record.lifecycle.kind === 'finite' ? '一次性' : '长期'} ·{' '}
                {record.lifecycle.state === 'active'
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
        );
      })}
    </section>
  );
}

export const CreateCrossProjectMainAgent = observer(function CreateCrossProjectMainAgent({
  onCreated,
}: {
  onCreated?: () => void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lifecycleKind, setLifecycleKind] = useState<'finite' | 'ongoing'>('finite');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [agent, setAgent] = useState('inherit');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt && !isMainAgentHostProject(project.id)
  );
  return (
    <form
      data-testid="cross-project-agent-form"
      className="mb-2 space-y-2 rounded-lg border border-border p-2"
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
              ...(agent !== 'inherit' && { primary: { agent } }),
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
      <p className="text-sm font-medium">新建主任务工作区</p>
      <label htmlFor="cross-project-agent-name" className="block text-xs text-foreground-muted">
        工作区名称
      </label>
      <Input
        id="cross-project-agent-name"
        data-testid="cross-project-agent-name"
        value={name}
        placeholder="工作区名称"
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
      <label htmlFor="cross-project-agent-lifecycle" className="block text-xs text-foreground-muted">
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
      <label htmlFor="cross-project-agent-type" className="block text-xs text-foreground-muted">
        主任务 Agent
      </label>
      <Select.Root
        value={agent}
        onValueChange={(value) => {
          if (value) setAgent(value);
        }}
      >
        <Select.Trigger id="cross-project-agent-type" data-testid="cross-project-agent-type">
          <Select.Value>{agent === 'inherit' ? '跟随应用设置' : agent}</Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">跟随应用设置</Select.Item>
          {PROVIDER_CAPABLE_AGENTS.map((id) => (
            <Select.Item key={id} value={id}>
              {id}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <p className="text-xs text-foreground-muted">
        可先不关联项目；需要修改仓库时再加入。下面的选择只影响工作上下文。
      </p>
      {projects.map((project) => (
        <label key={project.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={projectIds.includes(project.id)}
            onChange={(event) =>
              setProjectIds(
                event.target.checked
                  ? [...projectIds, project.id]
                  : projectIds.filter((id) => id !== project.id)
              )
            }
          />
          {project.name}
        </label>
      ))}
      <Button
        data-testid="create-cross-project-agent"
        type="submit"
        disabled={saving || !name.trim()}
      >
        创建工作区
      </Button>
      {!projects.length && (
        <p className="text-xs text-foreground-muted">
          当前没有业务项目，仍可创建主任务；需要修改仓库时再关联或导入项目。
        </p>
      )}
    </form>
  );
});
