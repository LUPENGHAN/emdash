import { toast } from '@emdash/ui/react/primitives';
import { getRemoteClientClient } from '../api/browser/remote-client';

/** Switches this window between this computer and another one's Emdash. */
export async function switchComputer(serverId: string | null, name: string): Promise<void> {
  // The window reloads once the switch lands, replacing the toast.
  const switched = (async () => (await getRemoteClientClient()).switchTo({ serverId }))();
  toast.promise(switched, {
    loading: `Connecting to ${name}…`,
    success: `Using ${name}`,
    error: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  });
  await switched.catch(() => {});
}

/** Opens another computer in a window of its own (null: brings up the main window). */
export async function openComputerWindow(serverId: string | null, name: string): Promise<void> {
  try {
    await (await getRemoteClientClient()).openWindow({ serverId });
    toast.success(serverId ? `Opening ${name} in a new window` : 'Opening the main window');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}
