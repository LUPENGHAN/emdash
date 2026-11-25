import '@emdash/ui/style.css';
import type { GitFilePath } from '@emdash/core/runtimes/git/api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { portablePath } from '@core/primitives/desktop-runtime/api';

const mocks = vi.hoisted(() => ({
  setDiffStyle: vi.fn(),
}));

vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useTaskComposition: () => ({
    diffView: {
      diffStyle: 'split',
      setDiffStyle: mocks.setDiffStyle,
    },
  }),
}));

import { DiffToolbar } from '@core/features/source-control/browser/diff-view/main-panel/diff-toolbar';
import { DiffTabResource } from '@core/features/source-control/browser/diff-view/stores/diff-tab-resource';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Markdown diff toolbar', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('quickly switches a Markdown file between diff and document browsing', async () => {
    const tab = new DiffTabResource('markdown-diff', {
      path: portablePath('README.md') as GitFilePath,
      diffGroup: 'disk',
      originalRef: { kind: 'commit', sha: 'HEAD' },
    });

    await act(async () => root.render(<DiffToolbar tab={tab} />));

    const difference = buttonByText(host, '差异');
    const source = buttonByText(host, '源码');
    const browse = buttonByText(host, '浏览');
    expect(difference.getAttribute('aria-pressed')).toBe('true');
    expect(source.getAttribute('aria-pressed')).toBe('false');
    expect(browse.getAttribute('aria-pressed')).toBe('false');

    await act(async () => source.click());

    expect(tab.viewMode).toBe('source');
    expect(difference.getAttribute('aria-pressed')).toBe('false');
    expect(source.getAttribute('aria-pressed')).toBe('true');

    await act(async () => browse.click());

    expect(tab.viewMode).toBe('preview');
    expect(source.getAttribute('aria-pressed')).toBe('false');
    expect(browse.getAttribute('aria-pressed')).toBe('true');
  });
});

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) throw new Error(`找不到“${text}”按钮`);
  return button;
}
