import { log } from '@core/primitives/logging/browser/logger';
import { getAgentControlClient } from '../../api/browser/client';
import { executeAgentAction } from '../../browser/execute-agent-action';

const HEARTBEAT_MS = 30_000;

/**
 * Makes this window an agent-control executor: it checks in (with focus) so the main
 * process can pick the window in front of the user, then carries out the actions
 * addressed to it and reports back.
 */
export function installAgentControl(): () => void {
  const rendererId = crypto.randomUUID();
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const register = (focused = document.hasFocus()) => {
    void getAgentControlClient()
      .then((client) => client.register({ rendererId, focused }))
      .catch(() => {});
  };
  const onFocus = () => register(true);
  window.addEventListener('focus', onFocus);
  const heartbeat = window.setInterval(() => register(), HEARTBEAT_MS);
  register();

  void getAgentControlClient().then(async (client) => {
    const next = await client.requests.subscribe(undefined, {
      onEvent: (request) => {
        if (request.rendererId !== rendererId) return;
        void executeAgentAction(request.caller, request.action).then(
          (result) => client.respond({ requestId: request.requestId, ok: true, result }),
          (error: unknown) => {
            log.warn('agent control: action failed', { kind: request.action.kind, error });
            return client.respond({
              requestId: request.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        );
      },
      onGap: () => {},
    });
    if (disposed) next();
    else unsubscribe = next;
  });

  return () => {
    disposed = true;
    window.removeEventListener('focus', onFocus);
    window.clearInterval(heartbeat);
    unsubscribe?.();
  };
}
