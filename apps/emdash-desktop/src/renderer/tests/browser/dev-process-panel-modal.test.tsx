import '@emdash/ui/style.css';
import '@renderer/index.css';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevProcessPanelModal } from '@core/features/dev-perf/browser/DevProcessPanelModal';

const mocks = vi.hoisted(() => ({
  processSnapshot: vi.fn(),
  getVerboseSpawnLogging: vi.fn(),
  setVerboseSpawnLogging: vi.fn(),
}));

vi.mock('@core/features/dev-perf/api/browser/client', () => ({
  getDevPerfClient: async () => mocks,
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('DevProcessPanelModal', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.processSnapshot.mockReset().mockResolvedValue({
      supported: true,
      processes: [
        {
          pid: 100,
          ppid: 1,
          depth: 0,
          cpuPercent: 3,
          rssBytes: 100_000_000,
          command: '/Applications/Emdash.app/Contents/MacOS/Emdash',
        },
        {
          pid: 101,
          ppid: 100,
          depth: 1,
          cpuPercent: 4,
          rssBytes: 200_000_000,
          command: '/opt/homebrew/bin/codex resume session',
        },
        {
          pid: 102,
          ppid: 101,
          depth: 2,
          cpuPercent: 1,
          rssBytes: 30_000_000,
          command: '/opt/homebrew/bin/codex-code-mode-host --listen stdio',
        },
        {
          pid: 103,
          ppid: 100,
          depth: 1,
          cpuPercent: 0,
          rssBytes: 20_000_000,
          command: 'node /Users/me/Claude-Detection/scripts/build.mjs',
        },
      ],
    });
    mocks.getVerboseSpawnLogging.mockReset().mockResolvedValue({ enabled: false });
    mocks.setVerboseSpawnLogging.mockReset().mockResolvedValue({ enabled: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('defaults to an accessible table containing only detected agent processes', async () => {
    await act(async () => root.render(<DevProcessPanelModal />));
    await vi.waitFor(() => expect(host.textContent).toContain('运行中的 Agent 1 个'));
    expect(host.textContent).toContain('相关进程 2 个');

    expect(host.querySelector('h2')?.textContent).toBe('Agent 运行监控');
    expect(host.querySelectorAll('thead th[scope="col"]')).toHaveLength(5);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.querySelector('tbody')?.textContent).toContain('Codex');
    expect(host.querySelector('tbody')?.textContent).not.toContain('Claude-Detection');
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(
      '运行中的 Emdash 进程'
    );
  });
});
