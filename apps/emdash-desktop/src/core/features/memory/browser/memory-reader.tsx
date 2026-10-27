import { Markdown } from '@emdash/ui/react/components';
import { Button, Input, RelativeTime, Textarea } from '@emdash/ui/react/primitives';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { agentDisplayName } from '@core/features/conversations/contributions/browser/agent-actions';
import { openModal } from '@core/manifests/browser/modal-api';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { cn } from '@core/primitives/styling/browser/cn';
import { useMemory } from '../api/browser/use-memory';
import {
  MEMORY_DETAIL_MAX,
  MEMORY_TITLE_MAX,
  type MemoryRecord,
  type MemoryScope,
} from '../api/types';

/** Left titles, right Markdown. The user can add, edit, and delete. Agents only append. */
export function MemoryReader({ scope, description }: { scope: MemoryScope; description?: string }) {
  const { items, isLoading, isError, error, add, isAdding, update, remove } = useMemory(scope);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const shownKey = items.map((item) => item.id).join('\0');

  useEffect(() => {
    if (editingId) return;
    const ids = shownKey === '' ? [] : shownKey.split('\0');
    if (selectedId && ids.includes(selectedId)) return;
    setSelectedId(ids[0] ?? null);
  }, [editingId, selectedId, shownKey]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const confirmRemove = async (item: MemoryRecord) => {
    const confirmed = await openModal('confirmActionModal', {
      title: 'Delete this decision?',
      description: `“${item.title}” is removed from the list. This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (confirmed.success) await remove(item.id).catch(() => {});
  };

  const submit = async () => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    try {
      await add({ title: nextTitle, detail });
      setTitle('');
      setDetail('');
    } catch {
      // The hook already told the user.
    }
  };

  if (isError) {
    return (
      <p className="px-1 py-8 text-sm text-foreground-muted">
        {error instanceof Error ? error.message : 'Decisions could not be read'}
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {description ? <p className="px-1 text-sm text-foreground-muted">{description}</p> : null}
      <form
        className="flex flex-col gap-2 px-1"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          value={title}
          maxLength={MEMORY_TITLE_MAX}
          placeholder="Decision"
          aria-label="New decision title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          value={detail}
          rows={2}
          maxLength={MEMORY_DETAIL_MAX}
          placeholder="Why, or what was abandoned"
          aria-label="New decision details"
          onChange={(event) => setDetail(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={isAdding || !title.trim()}>
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      </form>
      {items.length === 0 && !isLoading ? (
        <p className="py-8 text-center text-sm text-foreground-muted">No decisions yet.</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2">
          <ul
            aria-label="Decisions"
            className="flex w-72 shrink-0 flex-col gap-0.5 overflow-y-auto"
          >
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  data-memory-id={item.id}
                  aria-current={item.id === selectedId}
                  className={cn(
                    'w-full rounded-md px-2 py-1.5 text-left text-sm',
                    item.id === selectedId && 'bg-background-2'
                  )}
                  onClick={() => {
                    if (editingId) return;
                    setSelectedId(item.id);
                  }}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <DecisionDocument
              item={selected}
              editing={editingId === selected.id}
              onEdit={() => setEditingId(selected.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={async (changes) => {
                await update({ id: selected.id, ...changes });
                setEditingId(null);
              }}
              onDelete={() => void confirmRemove(selected)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function DecisionDocument({
  item,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  item: MemoryRecord;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (changes: { title: string; detail: string }) => Promise<void>;
  onDelete: () => void;
}) {
  const openLink = useMarkdownLinkOpener();
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail ?? '');

  useEffect(() => {
    if (editing) return;
    setTitle(item.title);
    setDetail(item.detail ?? '');
  }, [editing, item.detail, item.id, item.title]);

  const save = async () => {
    if (!title.trim()) return;
    await onSave({ title, detail }).catch(() => {});
  };

  const source = item.source.kind === 'user' ? 'You' : agentDisplayName(item.source.providerId);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          <Input
            value={title}
            autoFocus
            maxLength={MEMORY_TITLE_MAX}
            aria-label="Decision title"
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            value={detail}
            rows={12}
            maxLength={MEMORY_DETAIL_MAX}
            aria-label="Decision details"
            onChange={(event) => setDetail(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button size="sm" disabled={!title.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex items-start justify-between gap-3 px-6 pt-5">
            <div className="min-w-0">
              <h1 className="text-lg font-medium">{item.title}</h1>
              <p className="mt-1 text-sm text-foreground-muted">
                {source}
                {' · '}
                <RelativeTime value={item.createdAt} />
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" aria-label="Edit" onClick={onEdit}>
                <Pencil className="size-3.5" />
              </Button>
              <Button size="sm" variant="ghost" aria-label="Delete" onClick={onDelete}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
          {item.detail ? (
            <Markdown
              content={item.detail}
              variant="full"
              allowHtml={false}
              className="w-full max-w-3xl px-6 py-5"
              headingIdPrefix={`decision-${item.id}-`}
              onOpenLink={openLink}
            />
          ) : (
            <p className="px-6 py-5 text-sm text-foreground-muted">No details.</p>
          )}
        </div>
      )}
    </div>
  );
}
