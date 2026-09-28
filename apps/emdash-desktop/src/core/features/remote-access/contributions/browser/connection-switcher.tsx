import { DropdownMenu } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { AppWindow, Check, ChevronsUpDown, Laptop, MonitorSmartphone, Plus } from 'lucide-react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import type { RemoteClientState } from '../../api';
import { getRemoteClientClient } from '../../api/browser/remote-client';
import { openComputerWindow, switchComputer } from '../../browser/computer-switch';
import { chooseComputerWindow } from '../../browser/open-computer-modal';

export const REMOTE_CLIENT_STATE_KEY = ['remoteClientState'];

export function useRemoteClientState() {
  return useQuery<RemoteClientState>({
    queryKey: REMOTE_CLIENT_STATE_KEY,
    queryFn: async () => (await getRemoteClientClient()).state(),
    refetchInterval: 3_000,
  });
}

/**
 * Which computer this window drives. Hidden until another computer is saved, so the
 * sidebar is unchanged for people who only use this one.
 */
export function ConnectionSwitcher() {
  const { navigate } = useNavigate();
  const { data: state } = useRemoteClientState();
  if (!state || (state.servers.length === 0 && !state.error)) return null;

  const active = state.servers.find((server) => server.id === state.activeServerId);
  const label = active?.name ?? 'This computer';
  const dot =
    state.connection === 'connected'
      ? 'bg-emerald-500'
      : state.connection === 'reconnecting' || state.connection === 'connecting'
        ? 'bg-amber-500'
        : state.connection === 'failed'
          ? 'bg-red-500'
          : null;
  const title =
    state.connection === 'reconnecting'
      ? `Reconnecting to ${label}…`
      : (state.error ??
        (state.versionMismatch
          ? `${label} runs Emdash ${state.versionMismatch.remote}; this one is ${state.versionMismatch.local}`
          : label));

  return (
    <div className="mx-2 mb-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              title={title}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground',
                active && 'text-foreground'
              )}
            >
              {active ? (
                <MonitorSmartphone className="size-3.5 shrink-0" />
              ) : (
                <Laptop className="size-3.5 shrink-0" />
              )}
              <span
                translate={active ? 'no' : undefined}
                className="min-w-0 flex-1 truncate text-left"
              >
                {label}
              </span>
              {dot ? <span className={cn('size-1.5 shrink-0 rounded-full', dot)} /> : null}
              {state.error && !active ? (
                <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
              ) : null}
              <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
            </button>
          }
        />
        <DropdownMenu.Content className="min-w-56">
          <DropdownMenu.Group>
            <DropdownMenu.Label>Use Emdash on</DropdownMenu.Label>
            {state.windowServerId ? (
              // This window has its own profile: this computer lives in the main window.
              <DropdownMenu.Item onClick={() => void openComputerWindow(null, 'this computer')}>
                <AppWindow className="size-4" />
                <span className="flex-1">This computer (main window)</span>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item onClick={() => void switchComputer(null, 'this computer')}>
                <Laptop className="size-4" />
                <span className="flex-1">This computer</span>
                {!active ? <Check className="size-4" /> : null}
              </DropdownMenu.Item>
            )}
            {state.servers.map((server) => (
              <DropdownMenu.Item
                key={server.id}
                onClick={() => {
                  if (active?.id !== server.id) chooseComputerWindow(server);
                }}
              >
                <MonitorSmartphone className="size-4" />
                <span translate="no" className="flex-1 truncate">
                  {server.name}
                </span>
                {active?.id === server.id ? <Check className="size-4" /> : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onClick={() => navigate(settingsViewDef({ tab: 'remote-access' }))}>
            <Plus className="size-4" />
            Add or manage computers…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
}
