import { randomUUID } from 'node:crypto';
import type {
  AgentCaller,
  AgentControlAction,
  AgentControlRequest,
  AgentControlResult,
} from '../api';

/** A window that has not checked in for this long is gone (closed, asleep, disconnected). */
export const RENDERER_STALE_MS = 90_000;
/** Actions that wait on a person (confirmations) get long; the rest should be quick. */
const ACTION_TIMEOUT_MS = 5 * 60_000;

type RendererEntry = { lastSeenAt: number; focusedAt: number };
type Pending = {
  resolve: (result: AgentControlResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type AgentControlDispatcherDeps = {
  emit: (request: AgentControlRequest) => void;
  now?: () => number;
};

/**
 * Routes agent actions to one window: the one focused most recently among those still
 * checking in. That is the window in front of the person — this computer's own, another
 * computer driving it, or a browser — so confirmations and panes show up where they look.
 */
export function createAgentControlDispatcher(deps: AgentControlDispatcherDeps) {
  const now = deps.now ?? Date.now;
  const renderers = new Map<string, RendererEntry>();
  const pending = new Map<string, Pending>();

  const pickRenderer = (): string | null => {
    let best: [string, RendererEntry] | null = null;
    for (const entry of renderers) {
      if (now() - entry[1].lastSeenAt > RENDERER_STALE_MS) {
        renderers.delete(entry[0]);
        continue;
      }
      if (!best || entry[1].focusedAt > best[1].focusedAt) best = entry;
    }
    return best?.[0] ?? null;
  };

  return {
    register(rendererId: string, focused: boolean): void {
      const existing = renderers.get(rendererId);
      renderers.set(rendererId, {
        lastSeenAt: now(),
        focusedAt: focused ? now() : (existing?.focusedAt ?? 0),
      });
    },

    dispatch(caller: AgentCaller, action: AgentControlAction): Promise<AgentControlResult> {
      const rendererId = pickRenderer();
      if (!rendererId) {
        return Promise.reject(
          new Error('No Emdash window is open to carry this out; ask the user to open Emdash.')
        );
      }
      const requestId = randomUUID();
      return new Promise<AgentControlResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('Emdash did not answer in time'));
        }, ACTION_TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
        deps.emit({ requestId, rendererId, caller, action });
      });
    },

    respond(input: {
      requestId: string;
      ok: boolean;
      result?: AgentControlResult;
      error?: string;
    }): void {
      const entry = pending.get(input.requestId);
      if (!entry) return;
      pending.delete(input.requestId);
      clearTimeout(entry.timer);
      if (input.ok) entry.resolve(input.result ?? { text: 'Done.' });
      else entry.reject(new Error(input.error ?? 'Emdash could not carry this out'));
    },

    dispose(): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Emdash is shutting down'));
      }
      pending.clear();
    },
  };
}

export type AgentControlDispatcher = ReturnType<typeof createAgentControlDispatcher>;
