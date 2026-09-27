import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentControlRequest } from '../api';
import { createAgentControlDispatcher, RENDERER_STALE_MS } from './agent-control-dispatcher';

const caller = {
  conversationId: 'c',
  taskId: 't',
  projectId: 'p',
  providerId: 'claude',
  title: 'x',
  cwd: null,
};

describe('createAgentControlDispatcher', () => {
  afterEach(() => vi.useRealTimers());

  it('sends each action to the window focused most recently and resolves with its answer', async () => {
    let now = 1_000;
    const emitted: AgentControlRequest[] = [];
    const dispatcher = createAgentControlDispatcher({
      emit: (request) => emitted.push(request),
      now: () => now,
    });
    dispatcher.register('desktop', true);
    now += 10;
    dispatcher.register('laptop', true);
    now += 10;
    dispatcher.register('desktop', false); // a heartbeat without focus keeps the order

    const pending = dispatcher.dispatch(caller, { kind: 'notify', message: 'hi' });
    expect(emitted[0]).toMatchObject({ rendererId: 'laptop', caller, action: { kind: 'notify' } });
    dispatcher.respond({ requestId: emitted[0]!.requestId, ok: true, result: { text: 'ok' } });
    await expect(pending).resolves.toEqual({ text: 'ok' });
  });

  it('turns a refusal into an error and ignores unknown answers', async () => {
    const emitted: AgentControlRequest[] = [];
    const dispatcher = createAgentControlDispatcher({ emit: (r) => emitted.push(r) });
    dispatcher.register('w', true);
    const pending = dispatcher.dispatch(caller, { kind: 'run_in_terminal', command: 'ls' });
    dispatcher.respond({ requestId: 'unknown', ok: true });
    dispatcher.respond({ requestId: emitted[0]!.requestId, ok: false, error: 'declined' });
    await expect(pending).rejects.toThrow('declined');
  });

  it('fails fast without a live window', async () => {
    let now = 0;
    const dispatcher = createAgentControlDispatcher({ emit: () => {}, now: () => now });
    await expect(dispatcher.dispatch(caller, { kind: 'notify', message: 'x' })).rejects.toThrow(
      'No Emdash window'
    );
    dispatcher.register('w', true);
    now += RENDERER_STALE_MS + 1;
    await expect(dispatcher.dispatch(caller, { kind: 'notify', message: 'x' })).rejects.toThrow(
      'No Emdash window'
    );
  });

  it('gives up on windows that never answer', async () => {
    vi.useFakeTimers();
    const dispatcher = createAgentControlDispatcher({ emit: () => {} });
    dispatcher.register('w', true);
    const pending = dispatcher.dispatch(caller, { kind: 'notify', message: 'x' });
    const assertion = expect(pending).rejects.toThrow('did not answer');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await assertion;
  });
});
