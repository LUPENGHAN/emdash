import '@emdash/ui/style.css';
import '@renderer/index.css';
import { Tooltip } from '@emdash/ui/react/primitives';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { MemoryRecord } from '@core/features/memory/api/types';
import { MemoryReader } from '@core/features/memory/browser/memory-reader';
import { ThemeProvider } from '@core/primitives/theme/browser';

const harness = vi.hoisted(() => ({
  items: [] as MemoryRecord[],
  isLoading: false,
  isError: false,
  error: null as Error | null,
  add: vi.fn(async () => ({}) as MemoryRecord),
  update: vi.fn(async () => ({}) as MemoryRecord),
  remove: vi.fn(async () => undefined),
}));

const modals = vi.hoisted(() => ({
  openModal: vi.fn(
    async (..._args: unknown[]): Promise<{ success: boolean }> => ({ success: false })
  ),
}));

vi.mock('@core/features/memory/api/browser/use-memory', () => ({
  useMemory: () => ({
    items: harness.items,
    isLoading: harness.isLoading,
    isError: harness.isError,
    error: harness.error,
    add: harness.add,
    isAdding: false,
    update: harness.update,
    remove: harness.remove,
  }),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  openModal: modals.openModal,
}));

function decision(input: Pick<MemoryRecord, 'id' | 'title'> & Partial<MemoryRecord>): MemoryRecord {
  return {
    source: { kind: 'user' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...input,
  };
}

const first = decision({
  id: 'm1',
  title: 'Share the list',
  detail: ['## Why', '', 'before <em>markup</em>', '', '<script>alert(1)</script>'].join('\n'),
});
const second = decision({ id: 'm2', title: 'No body' });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  harness.items = [first, second];
  harness.isLoading = false;
  harness.isError = false;
  harness.error = null;
  harness.add.mockClear();
  harness.update.mockClear();
  harness.remove.mockClear();
  modals.openModal.mockReset();
  modals.openModal.mockResolvedValue({ success: false });
  host = document.createElement('div');
  host.style.cssText = 'width:1080px;height:640px;display:flex;flex-direction:column';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function renderReader() {
  flushSync(() => {
    root.render(
      <ThemeProvider theme="emlight" onThemeChange={() => {}}>
        <Tooltip.Provider>
          <MemoryReader
            scope={{ kind: 'project', projectId: 'p1' }}
            description="Decisions for this project."
          />
        </Tooltip.Provider>
      </ThemeProvider>
    );
  });
}

describe('MemoryReader', () => {
  it('opens the first decision as markdown and does not render raw HTML', async () => {
    renderReader();
    await expect
      .element(page.getByRole('heading', { name: 'Share the list', level: 1 }))
      .toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Why', level: 2 })).toBeVisible();
    expect(host.querySelector('em')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
  });

  it('switches to a decision that has no body', async () => {
    renderReader();
    await page.getByRole('button', { name: 'No body' }).click();
    await expect.element(page.getByRole('heading', { name: 'No body', level: 1 })).toBeVisible();
    await expect.element(page.getByText('No details.')).toBeVisible();
  });

  it('saves an edit and deletes only after confirmation', async () => {
    renderReader();
    await page.getByRole('button', { name: 'Edit' }).click();
    const title = page.getByRole('textbox', { name: 'Decision title', exact: true });
    await title.fill('Share every worktree');
    await page.getByRole('button', { name: 'Save' }).click();
    expect(harness.update).toHaveBeenCalledWith({
      id: 'm1',
      title: 'Share every worktree',
      detail: first.detail,
    });

    modals.openModal.mockResolvedValueOnce({ success: true });
    await page.getByRole('button', { name: 'Delete' }).click();
    expect(JSON.stringify(modals.openModal.mock.calls[0]?.[1])).toContain('Share the list');
    expect(harness.remove).toHaveBeenCalledWith('m1');
  });

  it('shows an empty list and refuses to look empty when the store cannot be read', async () => {
    harness.items = [];
    renderReader();
    await expect.element(page.getByText('No decisions yet.')).toBeVisible();

    harness.isError = true;
    harness.error = new Error('Decisions could not be read');
    renderReader();
    await expect.element(page.getByText('Decisions could not be read')).toBeVisible();
    expect(host.querySelector('[aria-label="New decision title"]')).toBeNull();
  });
});
