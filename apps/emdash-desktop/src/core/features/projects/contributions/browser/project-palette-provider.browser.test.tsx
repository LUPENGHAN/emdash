import { Command } from 'cmdk';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { createProjectPaletteProvider } from './project-palette-provider';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  restoreProject: vi.fn(async () => {}),
  projects: new Map<string, { data: { archivedAt: string | null } }>(),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  asAvailableProject: () => undefined,
  getProjectManagerStore: () => ({
    projects: mocks.projects,
    restoreProject: mocks.restoreProject,
  }),
}));

vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('project palette row', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.projects.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it('preserves project presentation, dismissal, and navigation', async () => {
    const provider = createProjectPaletteProvider({
      search: async () => [],
      idle: () => [],
    });
    const Row = provider.render;
    const onSelect = vi.fn();

    await act(async () => {
      root.render(
        <Command shouldFilter={false}>
          <Command.List>
            <Row
              match={{
                id: 'project-1',
                title: 'Emdash',
                subtitle: '/repos/emdash',
                relevance: { band: 'exact', score: 1 },
              }}
              value="projects:project-1"
              onSelect={onSelect}
            />
          </Command.List>
        </Command>
      );
    });

    const row = host.querySelector<HTMLElement>('[cmdk-item]');
    expect(row?.textContent).toContain('Emdash');
    expect(row?.textContent).toContain('/repos/emdash');
    expect(row?.querySelector('svg')).not.toBeNull();

    await act(async () => row?.click());

    expect(onSelect).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith(projectViewDef({ projectId: 'project-1' }));
    expect(onSelect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mocks.restoreProject).not.toHaveBeenCalled();
  });

  it('labels an archived project and restores it before opening', async () => {
    mocks.projects.set('project-1', { data: { archivedAt: '2026-01-02T00:00:00.000Z' } });
    const provider = createProjectPaletteProvider({
      search: async () => [],
      idle: () => [],
    });
    const Row = provider.render;

    await act(async () => {
      root.render(
        <Command shouldFilter={false}>
          <Command.List>
            <Row
              match={{
                id: 'project-1',
                title: 'Emdash',
                subtitle: '/repos/emdash',
                relevance: { band: 'exact', score: 1 },
              }}
              value="projects:project-1"
              onSelect={vi.fn()}
            />
          </Command.List>
        </Command>
      );
    });

    expect(host.textContent).toContain('Archived');

    await act(async () => {
      host.querySelector<HTMLElement>('[cmdk-item]')?.click();
      await Promise.resolve();
    });

    expect(mocks.restoreProject).toHaveBeenCalledWith('project-1');
    expect(mocks.navigate).toHaveBeenCalledWith(projectViewDef({ projectId: 'project-1' }));
  });
});
