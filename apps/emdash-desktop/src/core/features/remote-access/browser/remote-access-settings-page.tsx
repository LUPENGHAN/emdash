import { PageLayout } from '@emdash/ui/react/patterns';
import {
  Button,
  Field,
  Input,
  RelativeTime,
  Select,
  Switch,
  toast,
} from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import {
  ALL_ADDRESSES,
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  type RemoteAccessDevice,
  type RemoteAccessLink,
  type RemoteAccessStatus,
} from '../api';
import { getRemoteAccessClient } from '../api/browser/client';
import { useRemoteClientState } from '../contributions/browser/connection-switcher';
import { OtherComputersSection } from './other-computers-section';

const STATUS_KEY = ['remoteAccessStatus'];
const LINK_KEY = ['remoteAccessLink'];
const DEVICES_KEY = ['remoteAccessDevices'];
const ACCESS_KEY_KEY = ['remoteAccessKey'];
const MIN_ACCESS_KEY_LENGTH = 12;

export function RemoteAccessSettingsPage() {
  const queryClient = useQueryClient();
  const { value, updateAsync } = useAppSettingsKey('remoteAccess');
  const settings = value ?? DEFAULT_REMOTE_ACCESS_SETTINGS;
  const [portDraft, setPortDraft] = useState(String(settings.port));
  useEffect(() => setPortDraft(String(settings.port)), [settings.port]);

  const { data: status } = useQuery<RemoteAccessStatus>({
    queryKey: STATUS_KEY,
    queryFn: async () => (await getRemoteAccessClient()).status(),
    refetchInterval: 3_000,
  });
  const { data: links = [] } = useQuery({
    queryKey: [...LINK_KEY, status?.url ?? null],
    queryFn: async () => (await getRemoteAccessClient()).links(),
    enabled: status?.state === 'listening',
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    void queryClient.invalidateQueries({ queryKey: LINK_KEY });
    void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
  };
  // The server restarts before the save returns, so the refreshed status is current.
  const save = async (next: Partial<typeof settings>) => {
    try {
      await updateAsync({ ...settings, ...next });
    } finally {
      refresh();
    }
  };

  const { data: clientState } = useRemoteClientState();
  const driving = clientState?.servers.find((server) => server.id === clientState.activeServerId);
  const addresses = [
    ...(status?.addresses ?? []),
    { name: 'All addresses', address: ALL_ADDRESSES },
  ];
  const knownAddress = addresses.some((entry) => entry.address === settings.host);
  const selected = addresses.find((entry) => entry.address === settings.host);

  return (
    <div className="space-y-8 pb-4">
      <PageLayout.Header
        sticky
        title="Remote access"
        description="Use this Emdash from a browser on another computer: projects, conversations, terminals and code all stay on this machine. Listen on your ZeroTier (or other private network) address and open the link there."
      />
      {driving ? (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-foreground-muted">
          This window is using {driving.name}: the browser access settings below are that
          computer’s.
        </p>
      ) : null}
      <Field.Group>
        <Field.Root>
          <div className="flex items-center gap-2">
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => void save({ enabled })}
            />
            <Field.Label>Allow browser access</Field.Label>
          </div>
        </Field.Root>
        <Field.Root>
          <Field.Label>Listen on</Field.Label>
          <Select.Root value={settings.host} onValueChange={(host) => host && void save({ host })}>
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value>
                {selected ? `${selected.name} · ${selected.address}` : settings.host}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="start" width="trigger">
              {!knownAddress ? (
                <Select.Item value={settings.host}>{settings.host} (not found)</Select.Item>
              ) : null}
              {addresses.map((entry) => (
                <Select.Item key={entry.address} value={entry.address}>
                  {entry.name} · {entry.address}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Field.Description>
            {settings.host === ALL_ADDRESSES
              ? 'Every network this computer joins can reach it, including public Wi-Fi. There is no HTTPS, so anyone on such a network could capture the sign-in; prefer the ZeroTier address when you can.'
              : 'Pick the ZeroTier address to reach this computer from your other devices. There is no HTTPS, so avoid addresses on networks you don’t control.'}
          </Field.Description>
        </Field.Root>
        <Field.Root>
          <Field.Label>Port</Field.Label>
          <Input
            inputMode="numeric"
            value={portDraft}
            onChange={(event) => setPortDraft(event.target.value)}
            onBlur={() => {
              const port = Number(portDraft);
              if (Number.isInteger(port) && port >= 1024 && port <= 65_535) {
                if (port !== settings.port) void save({ port });
              } else {
                setPortDraft(String(settings.port));
                toast.error('Pick a port between 1024 and 65535');
              }
            }}
          />
        </Field.Root>
        <StatusLine status={status} enabled={settings.enabled} />
        {links.length > 0 ? (
          <Field.Root>
            <Field.Label>{links.length > 1 ? 'Links' : 'Link'}</Field.Label>
            {links.map((link) => (
              <LinkRow key={link.url} link={link} labelled={links.length > 1} />
            ))}
            <Field.Description>
              Anyone who opens this link can run agents and commands on this computer as you. Only
              open it on your own devices.
            </Field.Description>
            <div>
              <Button
                variant="ghost"
                onClick={() =>
                  void (async () => {
                    await (await getRemoteAccessClient()).regenerateToken();
                    refresh();
                    toast.success('New link created; every device was signed out');
                  })()
                }
              >
                Create a new link
              </Button>
            </div>
          </Field.Root>
        ) : null}
        {settings.enabled ? <AccessKeySection /> : null}
        {settings.enabled ? <DevicesSection /> : null}
      </Field.Group>
      <OtherComputersSection />
    </div>
  );
}

/**
 * The access key: the same one on all of a person's computers lets a phone or browser
 * sign in with the address and the key, without copying each computer's link.
 */
function AccessKeySection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ACCESS_KEY_KEY,
    queryFn: async () => (await getRemoteAccessClient()).accessKey(),
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isSet = data?.set ?? false;

  const save = async (key: string | null) => {
    try {
      await (await getRemoteAccessClient()).setAccessKey({ key });
      setDraft('');
      setEditing(false);
      toast.success(key === null ? 'Access key turned off' : 'Access key saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the access key');
    } finally {
      void queryClient.invalidateQueries({ queryKey: ACCESS_KEY_KEY });
    }
  };

  return (
    <Field.Root>
      <Field.Label>Access key</Field.Label>
      {isSet && !editing ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">An access key is set</span>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void save(null)}>
            Turn off
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={`At least ${MIN_ACCESS_KEY_LENGTH} characters`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={draft.length < MIN_ACCESS_KEY_LENGTH}
            onClick={() => void save(draft)}
          >
            Save
          </Button>
          {editing ? (
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      )}
      <Field.Description>
        Set the same key on each of your computers: a phone or browser then signs in with the
        computer’s address and the key, no link needed. Five wrong keys lock that address out for 15
        minutes; a new device signing in shows a notification here.
      </Field.Description>
    </Field.Root>
  );
}

/** The devices signed in to this computer, each of which can be signed out alone. */
function DevicesSection() {
  const queryClient = useQueryClient();
  const { data: devices = [] } = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: async () => (await getRemoteAccessClient()).devices(),
    refetchInterval: 10_000,
  });

  const signOut = async (device: RemoteAccessDevice) => {
    await (await getRemoteAccessClient()).revokeDevice({ id: device.id });
    void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
    toast.success(`${device.name} was signed out`);
  };

  return (
    <Field.Root>
      <Field.Label>Signed-in devices</Field.Label>
      {devices.length === 0 ? (
        <p className="text-xs text-foreground-muted">No device has signed in yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span translate="no" className="truncate text-sm text-foreground">
                  {device.name}
                </span>
                <span className="flex gap-1 text-xs text-foreground-muted">
                  {device.lastAddress ? <span translate="no">{device.lastAddress}</span> : null}
                  {device.lastAddress ? <span>·</span> : null}
                  <RelativeTime value={device.lastSeenAt} compact />
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void signOut(device)}>
                Sign out
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Field.Root>
  );
}

function StatusLine({ status, enabled }: { status?: RemoteAccessStatus; enabled: boolean }) {
  if (!enabled || !status) return null;
  if (status.state === 'error') {
    return <p className="text-xs text-foreground-destructive">Could not start: {status.error}</p>;
  }
  if (status.state !== 'listening') return null;
  return (
    <p className="text-xs text-foreground-muted">
      Listening at {status.url} ·{' '}
      {status.clients === 1 ? '1 browser connected' : `${status.clients} browsers connected`}
    </p>
  );
}

function LinkRow({ link, labelled }: { link: RemoteAccessLink; labelled: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      {labelled ? <span className="text-xs text-foreground-muted">{link.name}</span> : null}
      <div className="flex gap-2">
        <Input readOnly value={link.url} className="font-mono text-xs" />
        <Button
          variant="secondary"
          onClick={() =>
            void navigator.clipboard
              .writeText(link.url)
              .then(() => toast.success('Link copied'))
              .catch(() => toast.error('Could not copy; select the link and copy it'))
          }
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
