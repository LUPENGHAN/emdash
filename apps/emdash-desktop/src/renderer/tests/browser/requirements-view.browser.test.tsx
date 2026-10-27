import '@emdash/ui/style.css';
import '@renderer/index.css';
import { Tooltip } from '@emdash/ui/react/primitives';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { Requirement } from '@core/features/requirements/api/types';
import { RequirementsView } from '@core/features/requirements/contributions/browser/requirements-view';
import { ThemeProvider } from '@core/primitives/theme/browser';

const harness = vi.hoisted(() => ({
  items: [] as Requirement[],
  update: vi.fn(async () => undefined),
  add: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

const modals = vi.hoisted(() => ({
  openModal: vi.fn(
    async (..._args: unknown[]): Promise<{ success: boolean }> => ({ success: false })
  ),
}));

vi.mock('@core/features/requirements/api/browser/use-requirements', () => ({
  useRequirements: () => ({
    items: harness.items,
    isLoading: false,
    add: harness.add,
    update: harness.update,
    remove: harness.remove,
  }),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  openModal: modals.openModal,
}));

function requirement(input: Pick<Requirement, 'id' | 'title'> & Partial<Requirement>): Requirement {
  return {
    status: 'open',
    source: { kind: 'user' },
    createdAt: Date.UTC(2026, 9, 27, 8, 0, 0),
    updatedAt: Date.UTC(2026, 9, 27, 8, 0, 0),
    ...input,
  };
}

const reading = requirement({
  id: 'reading',
  title: '用 Markdown 阅读需求',
  source: {
    kind: 'agent',
    providerId: 'claude',
    conversationId: 'conv-1',
    taskId: 'task-1',
  },
  detail: [
    '## 阅读',
    '',
    '点开一条需求后，左侧是列表，右侧是排版过的正文。',
    '',
    '- 标题、列表和代码按 Markdown 显示',
    '- 在左侧点另一条就换正文',
    '',
    '渲染在 `requirements-view.tsx`。',
    '',
    '```ts',
    'export function RequirementsView() {',
    '  return null;',
    '}',
    '```',
  ].join('\n'),
});

const hostile = requirement({
  id: 'hostile',
  title: '危险正文',
  detail: [
    '## 验收',
    '',
    'before <em>markup</em>',
    '',
    '<script>alert(1)</script>',
    '',
    '[x](javascript:alert(1))',
  ].join('\n'),
});

const blank = requirement({ id: 'blank', title: '没有正文' });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  harness.items = [reading, hostile, blank];
  harness.update.mockClear();
  harness.add.mockClear();
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

function renderView() {
  flushSync(() => {
    root.render(
      <ThemeProvider theme="emlight" onThemeChange={() => {}}>
        <Tooltip.Provider>
          <RequirementsView projectId="project-1" />
        </Tooltip.Provider>
      </ThemeProvider>
    );
  });
}

function saveShot(name: string) {
  return page.screenshot({
    element: host,
    path: `../../../../../../outputs/requirements-reader/${name}`,
  });
}

describe('RequirementsView', () => {
  it('opens the first requirement as a markdown document beside the list', async () => {
    await page.viewport(1100, 720);
    renderView();

    await expect.element(page.getByRole('heading', { name: '阅读', level: 2 })).toBeVisible();
    await expect.element(page.getByText('渲染在', { exact: false })).toBeVisible();
    expect(host.querySelector('p.whitespace-pre-wrap')).toBeNull();
    expect(host.querySelector('[aria-current="true"]')?.textContent).toBe(reading.title);
    await saveShot('reading.png');
  });

  it('switches documents and does not render raw HTML', async () => {
    renderView();
    await page.getByRole('button', { name: hostile.title }).click();

    await expect.element(page.getByRole('heading', { name: '验收', level: 2 })).toBeVisible();
    expect(host.querySelector('em')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    await saveShot('switched.png');
  });

  it('keeps the open draft when another requirement is clicked', async () => {
    renderView();
    await page.getByRole('button', { name: 'Edit' }).click();
    const details = page.getByRole('textbox', { name: 'Requirement details' });
    await expect.element(details).toHaveValue(expect.stringContaining('## 阅读'));

    await page.getByRole('button', { name: hostile.title }).click();

    await expect.element(details).toHaveValue(expect.stringContaining('## 阅读'));
    expect(host.querySelector('h2')).toBeNull();
    await saveShot('editing.png');
  });

  it('keeps the selected requirement when the list gains an item', async () => {
    renderView();
    await page.getByRole('button', { name: hostile.title }).click();
    await expect.element(page.getByRole('heading', { name: '验收', level: 2 })).toBeVisible();

    harness.items = [
      ...harness.items,
      requirement({ id: 'later', title: '后来新增', detail: '## 新增\n\n后来的一条。' }),
    ];
    renderView();

    await expect.element(page.getByRole('heading', { name: '验收', level: 2 })).toBeVisible();
    await expect.element(page.getByRole('button', { name: '后来新增' })).toBeVisible();
  });

  it('shows an empty filter without the sidebar', async () => {
    renderView();
    await page.getByRole('button', { name: 'Done (0)' }).click();

    await expect.element(page.getByText('No done requirements.')).toBeVisible();
    expect(host.querySelector('[aria-label="Requirements"]')).toBeNull();
    await saveShot('empty-filter.png');
  });

  it('shows a selected requirement that has no detail', async () => {
    renderView();
    await page.getByRole('button', { name: blank.title }).click();

    await expect.element(page.getByRole('heading', { name: blank.title, level: 1 })).toBeVisible();
    await expect.element(page.getByText('No details.')).toBeVisible();
    await saveShot('no-details.png');
  });

  it('indents open sub-requirements and keeps a done parent that still has open ones', async () => {
    harness.items = [
      requirement({ id: 'parent', title: 'Parent', createdAt: 10, updatedAt: 10 }),
      requirement({
        id: 'older',
        title: 'Older child',
        parentId: 'parent',
        createdAt: 20,
        updatedAt: 20,
      }),
      requirement({
        id: 'newer',
        title: 'Newer child',
        parentId: 'parent',
        status: 'done',
        createdAt: 30,
        updatedAt: 30,
      }),
      requirement({
        id: 'finished',
        title: 'Finished parent',
        status: 'done',
        createdAt: 1,
        updatedAt: 1,
      }),
      requirement({
        id: 'left',
        title: 'Left open',
        parentId: 'finished',
        createdAt: 40,
        updatedAt: 40,
      }),
    ];
    renderView();

    expect(rowIds()).toEqual(['parent', 'older', 'finished', 'left']);
    expect(host.querySelector('[data-depth="1"]')?.getAttribute('data-requirement-id')).toBe(
      'older'
    );
    expect(host.querySelector('[aria-label="Requirements"]')?.textContent).toContain('1/2');
    expect(host.textContent).toContain('Open (3)');
    expect(host.textContent).toContain('Done (2)');

    await page.getByRole('button', { name: 'Done (2)' }).click();
    await expect.element(page.getByRole('button', { name: 'Newer child' })).toBeVisible();

    expect(rowIds()).toEqual(['finished', 'parent', 'newer']);
    expect(host.textContent).toContain('Done (2)');
    expect(host.querySelector('[aria-label="Requirements"]')?.textContent).not.toContain(
      'Older child'
    );
  });

  it('confirms deleting sub-requirements and starts a task from the open ones', async () => {
    harness.items = [
      requirement({
        id: 'parent',
        title: 'Parent',
        detail: 'the body',
        createdAt: 10,
        updatedAt: 10,
      }),
      requirement({
        id: 'open-child',
        title: 'Open child',
        parentId: 'parent',
        createdAt: 20,
        updatedAt: 20,
      }),
      requirement({
        id: 'done-child',
        title: 'Done child',
        parentId: 'parent',
        status: 'done',
        createdAt: 30,
        updatedAt: 30,
      }),
    ];
    renderView();

    await page.getByRole('button', { name: 'Start task' }).click();
    expect(modals.openModal).toHaveBeenCalledWith(
      'taskModal',
      expect.objectContaining({
        projectId: 'project-1',
        initialName: 'Parent',
        initialPrompt: 'Parent\n\nthe body\n\n- Open child',
      })
    );
    expect(JSON.stringify(modals.openModal.mock.calls[0]?.[1])).not.toContain('Done child');

    modals.openModal.mockResolvedValueOnce({ success: true });
    await page.getByRole('button', { name: 'Delete' }).click();
    expect(modals.openModal).toHaveBeenCalledWith(
      'confirmActionModal',
      expect.objectContaining({
        description:
          '“Parent” and its 2 sub-requirements are removed from the list. This cannot be undone.',
      })
    );
    expect(harness.remove).toHaveBeenCalledWith('parent');
  });

  it('adds a sub-requirement on a top-level item only', async () => {
    harness.items = [
      requirement({ id: 'parent', title: 'Parent', createdAt: 10, updatedAt: 10 }),
      requirement({
        id: 'child',
        title: 'Child item',
        parentId: 'parent',
        createdAt: 20,
        updatedAt: 20,
      }),
    ];
    renderView();

    await page.getByRole('button', { name: 'Add sub-requirement' }).click();
    const title = page.getByRole('textbox', { name: 'Sub-requirement title' });
    await expect.element(title).toBeVisible();
    await title.fill('Nested');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    expect(harness.add).toHaveBeenCalledWith({ title: 'Nested', parentId: 'parent' });

    await page.getByRole('button', { name: 'Child item' }).click();
    expect(host.querySelector('[aria-label="Add sub-requirement"]')).toBeNull();
  });
});

function rowIds(): string[] {
  return [...host.querySelectorAll('[data-requirement-id]')].map(
    (row) => row.getAttribute('data-requirement-id') ?? ''
  );
}
