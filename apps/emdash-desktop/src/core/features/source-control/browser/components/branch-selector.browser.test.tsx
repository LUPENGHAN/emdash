import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchSelector } from './branch-selector';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('BranchSelector degraded actions', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('keeps refresh focusable with a reason and does not present unavailable branches as empty', async () => {
    const onRefresh = vi.fn();
    await act(async () => {
      root.render(
        <BranchSelector
          branches={[]}
          onValueChange={vi.fn()}
          onRefresh={onRefresh}
          refreshDisabledReason="Unavailable while this Project’s Machine is offline."
          observationKind="unavailable"
        />
      );
    });

    const trigger = host.querySelector('button');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const refresh = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh branches"]'
    );
    expect(refresh?.disabled).toBe(false);
    expect(refresh?.getAttribute('aria-disabled')).toBe('true');
    expect(refresh?.getAttribute('aria-description')).toContain('Machine is offline');
    refresh?.click();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Branches unavailable');
  });

  it('does not open or select when selection is disabled', async () => {
    const onValueChange = vi.fn();
    const reason = 'Unavailable while this Project’s Machine is offline.';
    await act(async () => {
      root.render(
        <BranchSelector
          branches={[
            { type: 'local', branch: 'main' },
            { type: 'local', branch: 'feature' },
          ]}
          onValueChange={onValueChange}
          selectionDisabledReason={reason}
        />
      );
    });

    const trigger = host.querySelector('button');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('input[placeholder="Search branches"]')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger?.getAttribute('aria-disabled')).toBe('true');
    expect(trigger?.getAttribute('aria-description')).toContain('Machine is offline');
    expect(trigger?.hasAttribute('disabled')).toBe(false);
  });

  it('does not select a branch when the list closes', async () => {
    const onValueChange = vi.fn();
    await act(async () => {
      root.render(
        <BranchSelector
          branches={[{ type: 'local', branch: 'feature' }]}
          onValueChange={onValueChange}
        />
      );
    });

    const trigger = host.querySelector('button');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const search = document.querySelector('input[placeholder="Search branches"]');
    expect(search).not.toBeNull();

    await act(async () => {
      search?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('selects the local or remote branch that was clicked', async () => {
    const onValueChange = vi.fn();
    const local = { type: 'local' as const, branch: 'feature' };
    const remote = {
      type: 'remote' as const,
      branch: 'feature',
      remote: { name: 'origin', url: 'https://example.com/repo.git' },
    };
    await act(async () => {
      root.render(<BranchSelector branches={[local, remote]} onValueChange={onValueChange} />);
    });

    const trigger = host.querySelector('button');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const localOption = [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === 'feature'
    );
    await act(async () => {
      localOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenLastCalledWith(local);

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const remoteTab = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Remote')
    );
    await act(async () => {
      remoteTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const remoteOption = [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === 'origin/feature'
    );
    await act(async () => {
      remoteOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledTimes(2);
    expect(onValueChange).toHaveBeenLastCalledWith(remote);
  });
});
