import {
  Button,
  Checkbox,
  Input,
  RelativeTime,
  Textarea,
  ToggleGroup,
  Tooltip,
} from '@emdash/ui/react/primitives';
import { ChevronDown, ChevronRight, Pencil, Play, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { agentDisplayName } from '@core/features/conversations/contributions/browser/agent-actions';
import { openModal } from '@core/manifests/browser/modal-api';
import { cn } from '@core/primitives/styling/browser/cn';
import { useRequirements } from '../../api/browser/use-requirements';
import type { Requirement } from '../../api/types';
import { QuickRequirementInput } from '../../browser/quick-requirement-input';

type Filter = Requirement['status'];

/** The project's "Requirements" tab: every item, to edit, finish, delete or start as a task. */
export function RequirementsView({ projectId }: { projectId: string }) {
  const { items, isLoading, add, update, remove } = useRequirements(projectId);
  const [filter, setFilter] = useState<Filter>('open');
  const openCount = items.filter((item) => item.status === 'open').length;
  const shown = items.filter((item) => item.status === filter);

  const confirmRemove = async (item: Requirement) => {
    const confirmed = await openModal('confirmActionModal', {
      title: 'Delete this requirement?',
      description: `“${item.title}” is removed from the list. This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (confirmed.success) await remove(item.id).catch(() => {});
  };

  const startTask = (item: Requirement) =>
    void openModal('taskModal', {
      projectId,
      initialName: item.title,
      initialPrompt: item.detail ? `${item.title}\n\n${item.detail}` : item.title,
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <QuickRequirementInput onAdd={add} />
        </div>
        <ToggleGroup.Root
          multiple={false}
          value={[filter]}
          aria-label="Requirement status"
          onValueChange={([value]) => {
            if (value === 'open' || value === 'done') setFilter(value);
          }}
        >
          <ToggleGroup.Item value="open">Open ({openCount})</ToggleGroup.Item>
          <ToggleGroup.Item value="done">Done ({items.length - openCount})</ToggleGroup.Item>
        </ToggleGroup.Root>
      </div>
      {!isLoading && items.length === 0 ? (
        <p className="py-8 text-center text-sm text-foreground-muted">
          No requirements yet. Add one above, or ask an agent to note one.
        </p>
      ) : (
        <ul className="-mx-1 min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto px-1">
          {shown.map((item) => (
            <RequirementRow
              key={item.id}
              item={item}
              onUpdate={(changes) => update({ id: item.id, ...changes })}
              onRemove={() => void confirmRemove(item)}
              onStartTask={() => startTask(item)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RequirementRow({
  item,
  onUpdate,
  onRemove,
  onStartTask,
}: {
  item: Requirement;
  onUpdate: (
    changes: Partial<Pick<Requirement, 'title' | 'detail' | 'status'>>
  ) => Promise<unknown>;
  onRemove: () => void;
  onStartTask: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail ?? '');

  const startEditing = () => {
    setTitle(item.title);
    setDetail(item.detail ?? '');
    setEditing(true);
  };
  const save = async () => {
    if (!title.trim()) return;
    await onUpdate({ title, detail })
      .then(() => setEditing(false))
      .catch(() => {});
  };

  if (editing) {
    return (
      <li className="flex flex-col gap-2 py-2">
        <Input
          value={title}
          autoFocus
          aria-label="Requirement title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          value={detail}
          rows={4}
          placeholder="Details"
          aria-label="Requirement details"
          onChange={(event) => setDetail(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!title.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={item.status === 'done'}
          aria-label={item.status === 'done' ? 'Mark as not done' : 'Mark as done'}
          onCheckedChange={(checked) =>
            void onUpdate({ status: checked === true ? 'done' : 'open' }).catch(() => {})
          }
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
          onClick={() => setExpanded((value) => !value)}
        >
          {item.detail ? (
            expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-foreground-passive" />
            )
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          <span
            className={cn(
              'truncate',
              item.status === 'done' && 'text-foreground-muted line-through'
            )}
          >
            {item.title}
          </span>
        </button>
        {item.source.kind === 'agent' ? (
          <span className="shrink-0 text-xs text-foreground-passive">
            from {agentDisplayName(item.source.providerId)}
          </span>
        ) : null}
        <RelativeTime
          value={item.createdAt}
          compact
          className="shrink-0 text-xs text-foreground-passive"
        />
        <RowAction label="Start task" onClick={onStartTask}>
          <Play className="size-3.5" />
        </RowAction>
        <RowAction label="Edit" onClick={startEditing}>
          <Pencil className="size-3.5" />
        </RowAction>
        <RowAction label="Delete" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </RowAction>
      </div>
      {expanded && item.detail ? (
        // Agents write these: shown as plain text, never as HTML or Markdown.
        <p className="mt-1 ml-[3.25rem] text-xs whitespace-pre-wrap text-foreground-muted">
          {item.detail}
        </p>
      ) : null}
    </li>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon
            className="size-7 shrink-0 text-foreground-muted"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
