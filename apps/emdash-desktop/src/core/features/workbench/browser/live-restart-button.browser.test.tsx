import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  controlLiveRuntime: vi.fn(),
  confirm: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/primitives/app-identity/api/app-identity', () => ({ IS_LIVE: true }));
vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ controlLiveRuntime: mocks.controlLiveRuntime }),
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.confirm,
}));
vi.mock('@emdash/ui/react/primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Tooltip: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
  },
  toast: { success: mocks.success, error: mocks.error },
}));

import { LiveRestartButton } from './live-restart-button';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('LiveRestartButton', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.controlLiveRuntime.mockReset();
    mocks.confirm.mockReset();
    mocks.success.mockReset();
    mocks.error.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('requests one immediate full restart from the existing supervisor', async () => {
    mocks.confirm.mockResolvedValue({ success: true, data: undefined });
    mocks.controlLiveRuntime.mockResolvedValue({ success: true });
    await act(async () => root.render(<LiveRestartButton />));

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="立即完整重启"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());

    expect(mocks.confirm).toHaveBeenCalledWith({
      title: '立即完整重启 Emdash？',
      description:
        '当前窗口会立即关闭，正在运行的 Agent 和终端会被中断。现有 Supervisor 会在旧进程完全退出后启动唯一的新实例，并加载最新代码。',
      confirmLabel: '立即重启',
      cancelLabel: '取消',
      variant: 'destructive',
    });
    expect(mocks.controlLiveRuntime).toHaveBeenCalledOnce();
    expect(mocks.controlLiveRuntime).toHaveBeenCalledWith({ action: 'restart' });
    expect(button?.disabled).toBe(true);
    expect(mocks.success).toHaveBeenCalledWith('正在完整重启 Emdash');
  });

  it('does not restart when the confirmation is cancelled', async () => {
    mocks.confirm.mockResolvedValue({ success: false, error: { type: 'dismissed' } });
    await act(async () => root.render(<LiveRestartButton />));

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="立即完整重启"]');
    await act(async () => button?.click());

    expect(mocks.controlLiveRuntime).not.toHaveBeenCalled();
    expect(button?.disabled).toBe(false);
  });
});
