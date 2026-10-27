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
}));

vi.mock('@core/features/requirements/api/browser/use-requirements', () => ({
  useRequirements: () => ({
    items: harness.items,
    isLoading: false,
    add: vi.fn(async () => undefined),
    update: harness.update,
    remove: vi.fn(async () => undefined),
  }),
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
});
