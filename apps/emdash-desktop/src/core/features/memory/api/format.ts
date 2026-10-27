import { MEMORY_LIST_WITH_DETAIL, type MemoryRecord } from './types';

function dateOf(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

function indentDetail(detail: string): string {
  return detail
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** Newest first. The newest rows include the body; older rows are title, id, and date. */
export function formatMemoryList(items: MemoryRecord[]): string {
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  if (sorted.length === 0) return 'No decisions.';
  return sorted
    .map((item, index) => {
      const head = `${item.id} [${dateOf(item.createdAt)}] ${item.title}`;
      if (index >= MEMORY_LIST_WITH_DETAIL || !item.detail) return head;
      return `${head}\n${indentDetail(item.detail)}`;
    })
    .join('\n');
}

export function formatMemoryRecord(item: MemoryRecord): string {
  const head = `${item.id} [${new Date(item.createdAt).toISOString()}] ${item.title}`;
  return item.detail ? `${head}\n\n${item.detail}` : head;
}
