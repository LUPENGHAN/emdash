import { Button, Input, Select, toast } from '@emdash/ui/react/primitives';
import { Bot } from 'lucide-react';
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
import type { Coordinator } from '../api/types';

export function CrossProjectMainAgents() {
  const query = useCoordinators();
  const records = query.data?.filter((record) => record.kind === 'cross-project') ?? [];
  const { navigate } = useNavigate();
  const active = useViewParams(taskViewDef);
  const [opening, setOpening] = useState<string>();
  if (!records.length) return null;
  return (
    <div className="space-y-1 px-2 pb-2" data-testid="cross-project-main-agents">
      <p className="px-2 py-1 text-xs text-foreground-muted">Cross-project coordination</p>
      {records.map((record) => (
        <button
          key={record.id}
          type="button"
          aria-current={active?.taskId === record.taskId ? 'page' : undefined}
          disabled={opening === record.id}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-background-tertiary-1 aria-[current=page]:bg-background-tertiary-2"
          onClick={() => {
            setOpening(record.id);
            void getCoordinationClient()
              .then((client) => client.open({ id: record.id }))
              .then(async (opened) => {
                await when(() => !!getTaskManagerStore(opened.projectId), { timeout: 20000 });
                const manager = getTaskManagerStore(opened.projectId);
                if (!manager) throw new Error('The document storage project is unavailable.');
                await manager.loadTasks();
                navigate(taskViewDef({ projectId: opened.projectId, taskId: opened.taskId }));
              })
              .catch((error) =>
                toast.error('Could not open cross-project main agent', {
                  description: String(error),
                })
              )
              .finally(() => setOpening(undefined));
          }}
        >
          <Bot className="size-4 shrink-0" />
          <span className="truncate">{record.name}</span>
        </button>
      ))}
    </div>
  );
}

export const CreateCrossProjectMainAgent = observer(function CreateCrossProjectMainAgent({
  record,
}: {
  record: Coordinator;
}) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(record.projectId);
  const [projectIds, setProjectIds] = useState(record.projectIds);
  const [agent, setAgent] = useState('inherit');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt
  );
  return (
    <form
      data-testid="cross-project-agent-form"
      className="max-w-lg space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void getCoordinationClient()
          .then((client) =>
            client.createCrossProject({
              id: requestId,
              name,
              projectId,
              projectIds,
              ...(agent !== 'inherit' && { primary: { agent } }),
            })
          )
          .then(() => {
            toast.success('Cross-project main agent created');
            setName('');
            setRequestId(crypto.randomUUID());
          })
          .catch((error) =>
            toast.error('Could not create main agent', { description: String(error) })
          )
          .finally(() => setSaving(false));
      }}
    >
      <p className="text-sm">Create a cross-project main agent</p>
      <Input
        aria-label="Cross-project main agent name"
        data-testid="cross-project-agent-name"
        value={name}
        placeholder="Main agent name"
        onChange={(event) => setName(event.target.value)}
      />
      <p className="text-xs text-foreground-muted">Document storage project</p>
      <Select.Root
        value={projectId}
        onValueChange={(value) => {
          if (value) setProjectId(value);
        }}
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {projects.map((project) => (
            <Select.Item key={project.id} value={project.id}>
              {project.name}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <p className="text-xs text-foreground-muted">Main agent</p>
      <Select.Root
        value={agent}
        onValueChange={(value) => {
          if (value) setAgent(value);
        }}
      >
        <Select.Trigger data-testid="cross-project-agent-type">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">Follow agent settings</Select.Item>
          {PROVIDER_CAPABLE_AGENTS.map((id) => (
            <Select.Item key={id} value={id}>
              {id}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <p className="text-xs text-foreground-muted">
        Linked projects organize context. Project access is configured independently in the main
        agent settings.
      </p>
      {projects.map((project) => (
        <label key={project.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={project.id === projectId || projectIds.includes(project.id)}
            disabled={project.id === projectId}
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
        disabled={saving || !name.trim() || !projectId}
      >
        Create cross-project main agent
      </Button>
    </form>
  );
});
