import '@emdash/ui/style.css';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type CSSProperties } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { modalStore } from '@core/primitives/modals/react/modal-store';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';

vi.mock('@core/features/skills/browser/live-model-hooks', () => ({
  useInstalledSkillsLiveModel: () => ({ data: [], isLoading: false }),
}));

const skill: CatalogSkill = {
  id: 'frontend-design',
  displayName: 'Frontend Design',
  description: 'A skill used to exercise the details modal.',
  source: 'anthropic',
  skillMdContent: `---\nname: frontend-design\ndescription: A skill used to exercise the details modal.\n---\n\n${'A line of skill guidance.\n'.repeat(80)}`,
  frontmatter: {
    name: 'frontend-design',
    description: 'A skill used to exercise the details modal.',
  },
  installed: true,
  localPath: '/tmp/frontend-design',
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Skill detail close button over the window drag region', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider theme="emlight" onThemeChange={vi.fn()}>
            <header
              data-testid="titlebar"
              style={
                {
                  position: 'fixed',
                  inset: '0 0 auto',
                  height: 40,
                  zIndex: 20,
                  WebkitAppRegion: 'drag',
                } as CSSProperties
              }
            />
            <ModalRenderer />
          </ThemeProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => {
      void modalStore.open('skillDetailModal', {
        skill,
        host: LOCAL_HOST_REF,
        onInstall: vi.fn(async () => true),
        onUninstall: vi.fn(async () => true),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  afterEach(async () => {
    for (const entry of [...modalStore.stack]) modalStore.removeEntry(entry.key);
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps the close button out of the titlebar drag region and dismisses on click', async () => {
    const close = page.getByRole('button', { name: 'Close', exact: true });
    await expect.element(close).toBeVisible();

    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    const titlebar = host.querySelector<HTMLElement>('[data-testid="titlebar"]');
    expect(popup).not.toBeNull();
    expect(overlay).not.toBeNull();
    expect(titlebar).not.toBeNull();

    const button = close.element();
    const buttonBounds = button.getBoundingClientRect();
    expect(buttonBounds.top).toBeLessThan(titlebar!.getBoundingClientRect().bottom);

    // Browser clicks bypass Electron's native drag hit testing. The popup and
    // backdrop have to opt out; a working React handler cannot prove that.
    expect(getComputedStyle(popup!).getPropertyValue('-webkit-app-region')).toBe('no-drag');
    expect(getComputedStyle(overlay!).getPropertyValue('-webkit-app-region')).toBe('no-drag');

    await close.click();
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  });
});
