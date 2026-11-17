import { defineContract, liveModel, liveState } from '@emdash/wire/rpc';
import { cell, family, type RemoteModel } from '@emdash/wire/state';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';

const contract = defineContract({
  values: liveModel({
    key: z.object({ id: z.string() }),
    states: {
      value: liveState({ data: z.object({ count: z.number() }) }),
    },
  }),
}).values;

describe('useRemoteModelState', () => {
  let container: HTMLDivElement;
  let root: Root;
  let remoteModel: RemoteModel<typeof contract> | undefined;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await remoteModel?.dispose();
    container.remove();
  });

  it('does not resubscribe when callers pass inline options and callbacks', async () => {
    const source = cell({ count: 1 });
    const model: RemoteModel<typeof contract> = family(
      () => ({
        states: { value: Object.assign(source, { refresh: async () => {} }) },
        mutations: {},
      }),
      { lingerMs: 0 }
    );
    remoteModel = model;
    const getRemote = vi.fn(async () => model);
    let renderCount = 0;

    function Consumer({ parentVersion }: { readonly parentVersion: number }) {
      renderCount += 1;
      const result = useRemoteModelState(contract, () => getRemote(), { id: 'one' }, 'value', {
        initialValue: { count: 0 },
      });
      return (
        <div data-count={result.value?.count ?? 'missing'} data-parent-version={parentVersion} />
      );
    }

    await act(async () => {
      root.render(<Consumer parentVersion={1} />);
    });
    await vi.waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-count')).toBe('1')
    );

    for (const version of [2, 3, 4]) {
      await act(async () => {
        root.render(<Consumer parentVersion={version} />);
      });
    }

    expect(getRemote).toHaveBeenCalledTimes(1);
    expect(renderCount).toBeGreaterThan(1);

    await act(async () => {
      source.set({ count: 2 });
    });

    await vi.waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-count')).toBe('2')
    );
  });
});
