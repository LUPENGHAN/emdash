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
      setError(e instanceof Error ? e.message : '路由操作失败。');
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
          <h2 className="text-base font-medium">本地路由</h2>
          <p className="text-xs text-foreground-muted">
            应用启动后自动运行。已有会话保留自己的路由快照，目录变化不会改写历史。
          </p>
        </div>
        <span role="status" className="shrink-0 text-xs">
          {status.data?.state === 'ready' ? '运行中' : (status.data?.state ?? '加载中…')}
        </span>
        {status.data?.state !== 'ready' ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(async () => (await getModelGatewayClient()).start())}
          >
            重试路由
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
          会话路由
        </Button>
        <Button
          size="sm"
          variant={tab === 'accounts' ? 'secondary' : 'ghost'}
          onClick={() => setTab('accounts')}
        >
          网关账号
        </Button>
        <Button
          size="sm"
          variant={tab === 'usage' ? 'secondary' : 'ghost'}
          onClick={() => setTab('usage')}
        >
          路由用量
        </Button>
      </div>
      {tab === 'routes' ? (
        <div className="space-y-2 text-xs">
          {routes.data?.length === 0 ? (
            <p className="text-foreground-muted">
              还没有网关会话。创建会话时选择统一网关和已发布模型即可产生路由。
            </p>
          ) : null}
          {routes.data?.map((route) => (
            <div
              key={route.conversationId}
              className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate">{route.title}</span>
              <span className="text-foreground-muted">本地路由 →</span>
              <span>{route.providerName}</span>
              <code>{route.requestedModel ?? route.model}</code>
              {route.upstreamModel ? (
                <span className="text-foreground-muted">
                  → {route.upstreamModel} · {route.inboundProtocol} → {route.upstreamProtocol} ·
                  修订 {route.revision}
                </span>
              ) : null}
              {route.restartReason ? (
                <span role="status" className="text-foreground-muted">
                  {route.restartReason}
                </span>
              ) : null}
              {route.pendingName ? (
                <span className="text-foreground-muted">
                  → 本轮结束后切换到 {route.pendingName}
                </span>
              ) : null}
            </div>
          ))}
          {routes.error ? <p role="alert">无法加载会话路由。</p> : null}
        </div>
      ) : tab === 'accounts' ? (
        <div className="space-y-3">
          <p className="text-xs text-foreground-muted">
            授权网关直接使用的账号。Agent 自己的原生登录仍在“官方账号”中管理。
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
                连接 {provider === 'codex' ? 'Codex' : 'Claude'} OAuth
              </Button>
            ))}
          </div>
          {flow ? (
            <div className="space-y-2 rounded border border-border p-3">
              <p className="text-xs">请在浏览器中完成授权，正在等待回调…</p>
              <Button size="sm" variant="ghost" onClick={() => void openExternal(flow.url)}>
                打开授权页面
              </Button>
              <Input
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
                placeholder="如果没有自动完成，请粘贴回调 URL"
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
                提交回调
              </Button>
              {authorization.data?.error || authorization.error ? (
                <p role="alert" className="text-destructive text-xs">
                  {authorization.data?.error ?? '无法读取授权状态。'}
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
                关闭
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
                断开连接
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-auto text-xs" role="region" aria-label="网关用量" tabIndex={0}>
          <p className="mb-2 text-foreground-muted">
            请求用量独立保存，删除会话也不会删除这些历史记录。
          </p>
          <table className="w-full text-left">
            <caption className="sr-only">网关请求用量</caption>
            <thead>
              <tr>
                {['时间', '服务源', '模型', '输入', '输出', '缓存读取', '缓存写入', '状态'].map(
                  (label) => (
                    <th key={label} scope="col" className="p-1">
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
                    <span>{item.requestedModel ?? item.model}</span>
                    {item.upstreamModel ? (
                      <span className="block text-foreground-muted">
                        {item.upstreamModel} · {item.inboundProtocol} → {item.upstreamProtocol} ·
                        修订 {item.routeRevision}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-1">{item.status === 'missing' ? '未知' : item.inputTokens}</td>
                  <td className="p-1">{item.status === 'missing' ? '未知' : item.outputTokens}</td>
                  {item.status === 'complete' &&
                  item.cacheReadTokens === undefined &&
                  item.cacheWriteTokens === undefined ? (
                    <td className="p-1" colSpan={2}>
                      旧版缓存统计（{item.cachedTokens}）
                    </td>
                  ) : (
                    <>
                      <td className="p-1">{item.cacheReadTokens ?? '未知'}</td>
                      <td className="p-1">{item.cacheWriteTokens ?? '未知'}</td>
                    </>
                  )}
                  <td className="p-1">
                    {item.failed ? '失败' : item.status === 'complete' ? '完成' : '缺失'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage.data?.length === 0 ? <p>还没有路由用量记录。</p> : null}
          {usage.error ? <p role="alert">无法加载路由用量。</p> : null}
        </div>
      )}
    </section>
  );
}
