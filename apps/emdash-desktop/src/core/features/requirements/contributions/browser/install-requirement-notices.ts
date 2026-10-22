import { toast } from '@emdash/ui/react/primitives';
import { agentDisplayName } from '@core/features/conversations/contributions/browser/agent-actions';
import { getRequirementsClient } from '../../api/browser/client';

/** Tells the user when an agent notes a requirement; installed once, in the main window. */
export function installRequirementNotices(): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void getRequirementsClient().then(async (client) => {
    const next = await client.events.subscribe(undefined, {
      onEvent: ({ addedByAgent }) => {
        if (!addedByAgent) return;
        toast.info(
          `${agentDisplayName(addedByAgent.providerId)} noted a requirement: ${addedByAgent.title}`
        );
      },
      onGap: () => {},
    });
    if (disposed) next();
    else unsubscribe = next;
  });
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
