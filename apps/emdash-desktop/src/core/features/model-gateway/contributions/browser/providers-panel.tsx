import { Button, Input } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { getModelGatewayClient } from '../../api/browser/client';
import { useGatewayStatus } from '../../api/browser/use-gateway';
import { gatewaySourcePrefix } from '../../api/contract';

/** Native Providers contribution; the router consumes the same saved inventory. */
export function GatewayProvidersPanel() {
  const status = useGatewayStatus();
  const queryClient = useQueryClient();
  const configured = useAppSettingsKey('modelProviders');
  const [tab, setTab] = useState<'routes' | 'accounts' | 'usage'>('routes');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<{ provider: 'codex' | 'claude'; url: string; state: string }>();
  const [callback, setCallback] = useState('');
  const routes = useQuery({
    queryKey: ['modelGateway', 'routes'],
    queryFn: async () => (await getModelGatewayClient()).routes(),
    refetchInterval: 3000,
    enabled: tab === 'routes',
  });
  const usage = useQuery({
    queryKey: ['modelGateway', 'usage'],
    queryFn: async () => (await getModelGatewayClient()).usage({ limit: 100 }),
    refetchInterval: 5000,
    enabled: tab === 'usage',
  });
  const authorization = useQuery({
    queryKey: ['modelGateway', 'oauth', flow?.state],
    queryFn: async () => (await getModelGatewayClient()).oauthStatus({ state: flow!.state }),
    enabled: Boolean(flow),
    refetchInterval: (query) =>
      query.state.data?.status === 'wait' || !query.state.data ? 2000 : false,
    retry: false,
  });
  useEffect(() => {
    if (authorization.data?.status === 'ok') {
      setFlow(undefined);
      setCallback('');
      void queryClient.invalidateQueries({ queryKey: ['modelGateway', 'status'] });
    }
  }, [authorization.data?.status, queryClient]);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await status.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Router operation failed.');
    } finally {
      setBusy(false);
    }
  };
  const accounts =
    status.data?.providers.filter(
      (p) => !configured.value?.providers?.some((item) => gatewaySourcePrefix + item.id === p.id)
    ) ?? [];
  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Local routing</h3>
          <p className="text-xs text-foreground-muted">
            Starts automatically. Choose a published model in a gateway conversation. Existing
            provider-based sessions keep their saved routes.
          </p>
        </div>
        <span role="status" className="shrink-0 text-xs">
          {status.data?.state === 'ready' ? 'Running' : (status.data?.state ?? 'Loading…')}
        </span>
        {status.data?.state !== 'ready' ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(async () => (await getModelGatewayClient()).start())}
          >
            Retry router
          </Button>
        ) : null}
      </div>
      {status.data?.error || error ? (
        <p role="alert" className="text-destructive text-sm">
          {error ?? status.data?.error}
        </p>
      ) : null}
      {status.data?.usageError ? (
        <p role="alert" className="text-destructive text-sm">
          {status.data.usageError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={tab === 'routes' ? 'secondary' : 'ghost'}
          onClick={() => setTab('routes')}
        >
          Conversation routes
        </Button>
        <Button
          size="sm"
          variant={tab === 'accounts' ? 'secondary' : 'ghost'}
          onClick={() => setTab('accounts')}
        >
          Gateway accounts
        </Button>
        <Button
          size="sm"
          variant={tab === 'usage' ? 'secondary' : 'ghost'}
          onClick={() => setTab('usage')}
        >
          Router usage
        </Button>
      </div>
      {tab === 'routes' ? (
        <div className="space-y-2 text-xs">
          {routes.data?.length === 0 ? (
            <p className="text-foreground-muted">
              No routed conversations yet. Choose Gateway and a published model when creating a
              conversation.
            </p>
          ) : null}
          {routes.data?.map((route) => (
            <div
              key={route.conversationId}
              className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate">{route.title}</span>
              <span className="text-foreground-muted">Local router →</span>
              <span>{route.providerName}</span>
              <code>{route.model}</code>
              {route.upstreamModel ? (
                <span className="text-foreground-muted">
                  → {route.upstreamModel} · {route.inboundProtocol} → {route.upstreamProtocol} ·
                  revision {route.revision}
                </span>
              ) : null}
              {route.restartReason ? (
                <span role="status" className="text-foreground-muted">
                  {route.restartReason}
                </span>
              ) : null}
              {route.pendingName ? (
                <span className="text-foreground-muted">→ {route.pendingName} after this turn</span>
              ) : null}
            </div>
          ))}
          {routes.error ? <p role="alert">Could not load routes.</p> : null}
        </div>
      ) : tab === 'accounts' ? (
        <div className="space-y-3">
          <p className="text-xs text-foreground-muted">
            Authorize an account for requests through the router. Native agent sign-in remains under
            Official accounts.
          </p>
          <div className="flex gap-2">
            {(['codex', 'claude'] as const).map((provider) => (
              <Button
                key={provider}
                size="sm"
                variant="secondary"
                disabled={busy || Boolean(flow)}
                onClick={() =>
                  void run(async () => {
                    const result = await (await getModelGatewayClient()).beginOAuth({ provider });
                    setFlow({ ...result, provider });
                    await openExternal(result.url);
                  })
                }
              >
                Connect {provider === 'codex' ? 'Codex' : 'Claude'} OAuth
              </Button>
            ))}
          </div>
          {flow ? (
            <div className="space-y-2 rounded border border-border p-3">
              <p className="text-xs">
                Finish authorization in your browser. Waiting for the callback…
              </p>
              <Button size="sm" variant="ghost" onClick={() => void openExternal(flow.url)}>
                Open authorization
              </Button>
              <Input
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
                placeholder="Paste callback URL if it did not finish automatically"
              />
              <Button
                size="sm"
                disabled={busy || !callback.trim()}
                onClick={() =>
                  void run(async () =>
                    (await getModelGatewayClient()).completeOAuth({
                      provider: flow.provider,
                      redirectUrl: callback.trim(),
                    })
                  )
                }
              >
                Submit callback
              </Button>
              {authorization.data?.error || authorization.error ? (
                <p role="alert" className="text-destructive text-xs">
                  {authorization.data?.error ?? 'Authorization status is unavailable.'}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFlow(undefined);
                  setCallback('');
                }}
              >
                Close
              </Button>
            </div>
          ) : null}
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 rounded border border-border p-3"
            >
              <span className="flex-1 text-sm">{account.name}</span>
              <span className="text-xs text-foreground-muted">
                {account.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Responses'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    (await getModelGatewayClient()).removeAccount({
                      id: account.id.slice(gatewaySourcePrefix.length),
                    })
                  )
                }
              >
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-auto text-xs">
          <p className="mb-2 text-foreground-muted">
            Request usage is stored independently. Deleting conversations keeps these records.
          </p>
          <table className="w-full text-left">
            <thead>
              <tr>
                {['Time', 'Provider', 'Model', 'Input', 'Output', 'Cached', 'Status'].map(
                  (label) => (
                    <th key={label} className="p-1">
                      {label}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {usage.data?.map((item) => (
                <tr key={item.id}>
                  <td className="p-1">{new Date(item.at).toLocaleString()}</td>
                  <td className="p-1">
                    {status.data?.providers.find(
                      (p) => p.id === gatewaySourcePrefix + item.accountId
                    )?.name ??
                      configured.value?.providers?.find((p) => p.id === item.accountId)?.name ??
                      item.accountId}
                  </td>
                  <td className="p-1">
                    <span>{item.model}</span>
                    {item.upstreamModel ? (
                      <span className="block text-foreground-muted">
                        {item.upstreamModel} · {item.inboundProtocol} → {item.upstreamProtocol} ·
                        revision {item.routeRevision}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-1">
                    {item.status === 'missing' ? 'Unknown' : item.inputTokens}
                  </td>
                  <td className="p-1">
                    {item.status === 'missing' ? 'Unknown' : item.outputTokens}
                  </td>
                  <td className="p-1">
                    {item.status === 'missing' ? 'Unknown' : item.cachedTokens}
                  </td>
                  <td className="p-1">{item.failed ? 'Failed' : item.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage.data?.length === 0 ? <p>No router usage yet.</p> : null}
          {usage.error ? <p role="alert">Could not load usage.</p> : null}
        </div>
      )}
    </section>
  );
}
