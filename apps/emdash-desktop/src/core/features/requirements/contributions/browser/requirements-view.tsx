import { Markdown } from '@emdash/ui/react/components';
import {
  Button,
  Checkbox,
  Input,
  RelativeTime,
  Select,
  Textarea,
  ToggleGroup,
  Tooltip,
} from '@emdash/ui/react/primitives';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { agentDisplayName } from '@core/features/conversations/contributions/browser/agent-actions';
import { openModal } from '@core/manifests/browser/modal-api';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { cn } from '@core/primitives/styling/browser/cn';
import { useRequirements } from '../../api/browser/use-requirements';
import {
  REQUIREMENT_TOP_LEVEL,
  canChangeParent,
  childProgress,
  directChildren,
  parentChoices,
  requirementTaskPrompt,
  visibleRequirementRows,
} from '../../api/requirement-tree';
import type { Requirement } from '../../api/types';
import { QuickRequirementInput } from '../../browser/quick-requirement-input';

type Filter = Requirement['status'];

/** The project's "Requirements" tab: pick one from the side, read its Markdown on the right. */
export function RequirementsView({ projectId }: { projectId: string }) {
  const { items, isLoading, add, update, remove } = useRequirements(projectId);
  const [filter, setFilter] = useState<Filter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const openCount = items.filter((item) => item.status === 'open').length;
  const rows = visibleRequirementRows(items, filter);
  const shownKey = rows.map((row) => row.item.id).join('\0');

  // Keep the open requirement when the list refreshes. If it leaves the filter, follow the
  // first one still shown. Editing holds its place until Save or Cancel.
  useEffect(() => {
    if (editingId) return;
    const ids = shownKey === '' ? [] : shownKey.split('\0');
    if (selectedId && ids.includes(selectedId)) return;
    setSelectedId(ids[0] ?? null);
  }, [editingId, selectedId, shownKey]);

  const confirmRemove = async (item: Requirement) => {
    const childCount = directChildren(item.id, items).length;
    const removed =
      childCount === 0
        ? `“${item.title}” is removed from the list.`
        : `“${item.title}” and its ${childCount} sub-requirement${childCount === 1 ? '' : 's'} are removed from the list.`;
    const confirmed = await openModal('confirmActionModal', {
      title: 'Delete this requirement?',
      description: `${removed} This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (confirmed.success) await remove(item.id).catch(() => {});
  };

  const startTask = (item: Requirement) =>
    void openModal('taskModal', {
      projectId,
      initialName: item.title,
      initialPrompt: requirementTaskPrompt(item, items),
    });

  const select = (id: string) => {
    if (editingId) return;
    setSelectedId(id);
  };

  const selectedIsShown = selectedId !== null && rows.some((row) => row.item.id === selectedId);
  // Show the first visible requirement before the effect commits selectedId, so the empty
  // filter message does not flash on the way in.
  const displayedId = editingId ?? (selectedIsShown ? selectedId : (rows[0]?.item.id ?? null));
  const active = items.find((item) => item.id === displayedId) ?? null;
  const showReader = rows.length > 0 || (editingId !== null && active !== null);

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
      ) : showReader ? (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <ul
            aria-label="Requirements"
            className="flex w-72 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-1"
          >
            {rows.map((row) => (
              <RequirementListItem
                key={row.item.id}
                item={row.item}
                depth={row.depth}
                progress={childProgress(row.item, items)}
                selected={row.item.id === displayedId}
                onSelect={() => select(row.item.id)}
                onUpdate={(changes) => update({ id: row.item.id, ...changes })}
              />
            ))}
          </ul>
          {active ? (
            <RequirementDocument
              key={active.id}
              item={active}
              items={items}
              editing={editingId === active.id}
              onEdit={() => setEditingId(active.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(changes) => update({ id: active.id, ...changes })}
              onSaved={() => setEditingId(null)}
              onRemove={() => void confirmRemove(active)}
              onStartTask={() => startTask(active)}
              onAddChild={(title) => add({ title, parentId: active.id })}
              onChangeParent={(parentId) => update({ id: active.id, parentId })}
            />
          ) : null}
        </div>
      ) : !isLoading ? (
        <p className="py-8 text-center text-sm text-foreground-muted">No {filter} requirements.</p>
      ) : null}
    </div>
  );
}

function RequirementListItem({
  item,
  depth,
  progress,
  selected,
  onSelect,
  onUpdate,
}: {
  item: Requirement;
  depth: 0 | 1;
  progress: { open: number; total: number } | null;
  selected: boolean;
  onSelect: () => void;
  onUpdate: (changes: Partial<Pick<Requirement, 'status'>>) => Promise<unknown>;
}) {
  return (
    <li>
      <div
        data-requirement-id={item.id}
        data-depth={depth}
        className={cn(
          'flex items-center gap-2 rounded-md py-1.5 pr-2',
          depth === 1 ? 'pl-8' : 'pl-2',
          selected && 'bg-background-2'
        )}
      >
        <Checkbox
          checked={item.status === 'done'}
          aria-label={item.status === 'done' ? 'Mark as not done' : 'Mark as done'}
          onCheckedChange={(checked) =>
            void onUpdate({ status: checked === true ? 'done' : 'open' }).catch(() => {})
          }
        />
        <button
          type="button"
          aria-current={selected ? 'true' : undefined}
          className={cn(
            'min-w-0 flex-1 truncate text-left text-sm',
            item.status === 'done' && 'text-foreground-muted line-through'
          )}
          onClick={onSelect}
        >
          {item.title}
        </button>
        {progress ? (
          <span
            className="shrink-0 text-xs text-foreground-muted tabular-nums"
            aria-label={`${progress.open} of ${progress.total} sub-requirements open`}
          >
            {progress.open}/{progress.total}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function RequirementDocument({
  item,
  items,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onSaved,
  onRemove,
  onStartTask,
  onAddChild,
  onChangeParent,
}: {
  item: Requirement;
  items: Requirement[];
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (changes: { title: string; detail: string }) => Promise<unknown>;
  onSaved: () => void;
  onRemove: () => void;
  onStartTask: () => void;
  onAddChild: (title: string) => Promise<unknown>;
  onChangeParent: (parentId: string) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail ?? '');
  const [addingChild, setAddingChild] = useState(false);
  const [childTitle, setChildTitle] = useState('');
  const openLink = useMarkdownLinkOpener();
  const body = item.detail?.trim() ?? '';
  const canAddChild = !item.parentId;
  const choices = parentChoices(item, items);
  const showParent = canChangeParent(item, items);
  const parentValue = choices.some((choice) => choice.id === item.parentId)
    ? (item.parentId ?? REQUIREMENT_TOP_LEVEL)
    : REQUIREMENT_TOP_LEVEL;

  const submitChild = async () => {
    const next = childTitle.trim();
    if (!next) return;
    try {
      await onAddChild(next);
      setChildTitle('');
      setAddingChild(false);
    } catch {
      // The hook already told the user; keep the title so nothing is lost.
    }
  };

  const beginEdit = () => {
    setTitle(item.title);
    setDetail(item.detail ?? '');
    onEdit();
  };
  const save = async () => {
    if (!title.trim()) return;
    await onSave({ title, detail })
      .then(() => onSaved())
      .catch(() => {});
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          <Input
            value={title}
            autoFocus
            aria-label="Requirement title"
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            value={detail}
            rows={12}
            placeholder="Details"
            aria-label="Requirement details"
            onChange={(event) => setDetail(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!title.trim()}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base text-foreground">{item.title}</h1>
              <p className="mt-1 flex items-center gap-2 text-xs text-foreground-passive">
                {item.source.kind === 'agent' ? (
                  <span>from {agentDisplayName(item.source.providerId)}</span>
                ) : null}
                <RelativeTime value={item.createdAt} compact />
              </p>
              {showParent ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-foreground-passive">Parent</span>
                  <Select.Root
                    value={parentValue}
                    onValueChange={(value) => {
                      if (!value) return;
                      const next = value === REQUIREMENT_TOP_LEVEL ? '' : value;
                      const stored = item.parentId ?? '';
                      if (next === stored) return;
                      void onChangeParent(next).catch(() => {});
                    }}
                  >
                    <Select.Trigger size="sm" appearance="input" className="max-w-56">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content align="start">
                      <Select.Item value={REQUIREMENT_TOP_LEVEL}>Top level</Select.Item>
                      {choices.map((choice) => (
                        <Select.Item key={choice.id} value={choice.id}>
                          {choice.title}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center">
              {canAddChild ? (
                <RowAction label="Add sub-requirement" onClick={() => setAddingChild(true)}>
                  <Plus className="size-3.5" />
                </RowAction>
              ) : null}
              <RowAction label="Start task" onClick={onStartTask}>
                <Play className="size-3.5" />
              </RowAction>
              <RowAction label="Edit" onClick={beginEdit}>
                <Pencil className="size-3.5" />
              </RowAction>
              <RowAction label="Delete" onClick={onRemove}>
                <Trash2 className="size-3.5" />
              </RowAction>
            </div>
          </div>
          {addingChild && canAddChild ? (
            <form
              className="flex items-center gap-2 border-b border-border px-5 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitChild();
              }}
            >
              <Input
                value={childTitle}
                autoFocus
                aria-label="Sub-requirement title"
                placeholder="Sub-requirement title"
                onChange={(event) => setChildTitle(event.target.value)}
              />
              <Button size="sm" variant="primary" type="submit" disabled={!childTitle.trim()}>
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setAddingChild(false);
                  setChildTitle('');
                }}
              >
                Cancel
              </Button>
            </form>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {body ? (
              <Markdown
                content={body}
                variant="full"
                allowHtml={false}
                className="w-full max-w-3xl px-6 py-5"
                headingIdPrefix={`requirement-${item.id}-`}
                onOpenLink={openLink}
              />
            ) : (
              <p className="px-6 py-5 text-sm text-foreground-muted">No details.</p>
            )}
          </div>
        </>
      )}
    </div>
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
