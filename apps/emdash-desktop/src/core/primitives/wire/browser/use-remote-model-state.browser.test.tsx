import { liveModel, liveState } from '@emdash/wire/rpc';
import { cell, family, type RemoteModel } from '@emdash/wire/state';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useRemoteModelState } from './use-remote-model-state';

const contract = liveModel({
  key: z.object({ id: z.string() }),
  states: { current: liveState({ data: z.object({ label: z.string() }) }) },
});

it('owns a remote member until its view changes key or unmounts', async () => {
  const models: RemoteModel<typeof contract> = family(
    ({ id }: { id: string }) => ({
      states: { current: Object.assign(cell({ label: id }), { refresh: async () => {} }) },
      mutations: {},
    }),
    { lingerMs: 0 }
  );
  let held = 0;
  const retain = models.retain;
  models.retain = vi.fn((key) => {
    held++;
    const release = retain(key);
    return () => {
      held--;
      release();
    };
  });
  const getRemote = async () => models;
  function View({ id, enabled = true }: { id: string; enabled?: boolean }) {
    const state = useRemoteModelState(contract, getRemote, { id }, 'current', { enabled });
    return <span>{state.value?.label ?? 'Loading'}</span>;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View id="sdk" />));
    await vi.waitFor(() => expect(host.textContent).toBe('sdk'));
    expect(held).toBe(1);
    await act(async () => root.render(<View id="caller" />));
    await vi.waitFor(() => expect(host.textContent).toBe('caller'));
    expect(held).toBe(1);
    expect(models.retain).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<View id="caller" enabled={false} />));
    expect(held).toBe(0);
  } finally {
    await act(async () => root.unmount());
    await models.dispose();
    host.remove();
  }
  expect(held).toBe(0);
});
