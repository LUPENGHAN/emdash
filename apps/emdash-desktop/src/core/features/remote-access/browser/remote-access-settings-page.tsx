import { PageLayout } from '@emdash/ui/react/patterns';
import { Button, Field, Input, Select, Switch, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { DEFAULT_REMOTE_ACCESS_SETTINGS, type RemoteAccessStatus } from '../api';
import { getRemoteAccessClient } from '../api/browser/client';

const STATUS_KEY = ['remoteAccessStatus'];
const LINK_KEY = ['remoteAccessLink'];

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
  const { data: link } = useQuery({
    queryKey: [...LINK_KEY, status?.url ?? null],
    queryFn: async () => (await getRemoteAccessClient()).link(),
    enabled: status?.state === 'listening',
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    void queryClient.invalidateQueries({ queryKey: LINK_KEY });
  };
  // The server restarts before the save returns, so the refreshed status is current.
  const save = async (next: Partial<typeof settings>) => {
    try {
      await updateAsync({ ...settings, ...next });
    } finally {
      refresh();
    }
  };

  const addresses = status?.addresses ?? [];
  const knownAddress = addresses.some((entry) => entry.address === settings.host);

  return (
    <div className="space-y-8 pb-4">
      <PageLayout.Header
        sticky
        title="Remote access"
        description="Use this Emdash from a browser on another computer: projects, conversations, terminals and code all stay on this machine. Listen on your ZeroTier (or other private network) address and open the link there."
      />
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
                {addresses.find((entry) => entry.address === settings.host)?.name
                  ? `${addresses.find((entry) => entry.address === settings.host)!.name} · ${settings.host}`
                  : settings.host}
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
            Pick the ZeroTier address to reach this computer from your other devices. There is no
            HTTPS, so avoid addresses on networks you don’t control.
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
        {link ? (
          <Field.Root>
            <Field.Label>Link</Field.Label>
            <div className="flex gap-2">
              <Input readOnly value={link} className="font-mono text-xs" />
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(link)
                    .then(() => toast.success('Link copied'))
                    .catch(() => toast.error('Could not copy; select the link and copy it'))
                }
              >
                Copy
              </Button>
            </div>
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
                    toast.success('New link created; browsers using the old one were signed out');
                  })()
                }
              >
                Create a new link
              </Button>
            </div>
          </Field.Root>
        ) : null}
      </Field.Group>
    </div>
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
