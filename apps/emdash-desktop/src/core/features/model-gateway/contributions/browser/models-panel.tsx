import { CollectionView } from '@emdash/ui/react/patterns';
import { Button, Checkbox, Field, Input, Select } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  PROVIDER_PROTOCOL_LABELS,
  type ProviderProtocol,
} from '@core/features/model-providers/api';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getModelGatewayClient } from '../../api/browser/client';
import {
  agentUpstreamProtocol,
  codexNativeRouteRequired,
  configuredProtocols,
  gatewayModelsSettingsSchema,
  type GatewayModel,
} from '../../api/model-catalog';

/** One published directory; provider model discovery remains only an upstream suggestion list. */
export function GatewayModelsPanel() {
  const fieldId = useId();
  const settings = useAppSettingsKey('gatewayModels');
  const inventory = useAppSettingsKey('modelProviders');
  const client = useQueryClient();
  const [draft, setDraft] = useState<GatewayModel[]>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<string>();
  const models = draft ?? settings.value?.models ?? [];
  const editing = models.find((m) => m.id === selected);
  const providers = (inventory.value?.providers ?? []).filter((p) => !p.account);
  const provider = providers.find((p) => p.id === editing?.providerId);
  const patch = (value: Partial<GatewayModel>) => {
    setTestResult(undefined);
    setDraft(models.map((m) => (m.id === selected ? { ...m, ...value } : m)));
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save gateway models.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Gateway models</h3>
          <p className="text-xs text-foreground-muted">
            Publish a model alias once. Agents choose the model; the gateway chooses its provider
            endpoint and protocol.
          </p>
        </div>
        <Button
          size="sm"
          disabled={busy || !providers.length || settings.isLoading}
          onClick={() => {
            const id = crypto.randomUUID();
            setDraft([
              ...models,
              {
                id,
                alias: '',
                name: '',
                enabled: true,
                revision: 1,
                providerId: providers[0].id,
                protocolModels: {},
                protocolPolicy: { mode: 'auto' },
              },
            ]);
            setSelected(id);
          }}
        >
          Add model
        </Button>
      </div>
      <CollectionView
        items={models}
        getItemKey={(m) => m.id}
        density="compact"
        className="h-48"
        onItemClick={(m) => {
          setTestResult(undefined);
          setError(undefined);
          setSelected(m.id);
        }}
        emptySlot={
          <p className="p-3 text-xs text-foreground-muted">
            No models published. Add a model or preview the provider inventory below.
          </p>
        }
        renderRow={(m) => (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="min-w-0 flex-1 truncate">
              {m.name || 'Untitled model'} · {m.alias || 'Alias required'}
            </span>
            <span className="text-xs text-foreground-muted">
              {providers.find((p) => p.id === m.providerId)?.name ?? 'Missing provider'} ·{' '}
              {m.protocolPolicy.mode === 'auto'
                ? 'Automatic protocol'
                : PROVIDER_PROTOCOL_LABELS[m.protocolPolicy.protocol]}
              {m.enabled ? '' : ' · Disabled'}
            </span>
          </div>
        )}
      />
      {editing ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field.Root>
              <Field.Label>Display name</Field.Label>
              <Input value={editing.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field.Root>
            <Field.Root>
              <Field.Label>Model alias</Field.Label>
              <Input
                value={editing.alias}
                disabled={settings.value?.models.some((m) => m.id === editing.id)}
                onChange={(e) => patch({ alias: e.target.value })}
              />
              <Field.Description>Stable model name sent by agents.</Field.Description>
            </Field.Root>
          </div>
          <Field.Root>
            <Field.Label>Provider</Field.Label>
            <Select.Root
              value={editing.providerId}
              onValueChange={(next) => patch({ providerId: String(next), protocolModels: {} })}
            >
              <Select.Trigger appearance="input">
                <Select.Value>{provider?.name ?? 'Select a provider'}</Select.Value>
              </Select.Trigger>
              <Select.Content>
                {providers.map((p) => (
                  <Select.Item key={p.id} value={p.id}>
                    {p.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Field.Root>
          <Field.Group>
            <p className="text-sm font-medium">Supported protocols and upstream model names</p>
            <p className="text-xs text-foreground-muted">
              Enable only protocols this model actually supports. Each uses the corresponding
              provider URL and key.
            </p>
            {(provider ? configuredProtocols(provider) : []).map((protocol) => (
              <div key={protocol} className="flex items-center gap-3">
                <label className="flex w-52 shrink-0 items-center gap-2 text-xs">
                  <Checkbox
                    aria-label={PROVIDER_PROTOCOL_LABELS[protocol]}
                    aria-labelledby={`${fieldId}-${protocol}`}
                    checked={Boolean(editing.protocolModels[protocol])}
                    onCheckedChange={(checked) => {
                      const mapping = { ...editing.protocolModels };
                      if (checked)
                        mapping[protocol] = {
                          upstreamModel: Object.values(mapping)[0]?.upstreamModel ?? editing.alias,
                        };
                      else delete mapping[protocol];
                      patch({ protocolModels: mapping });
                    }}
                  />
                  <span id={`${fieldId}-${protocol}`}>{PROVIDER_PROTOCOL_LABELS[protocol]}</span>
                </label>
                {editing.protocolModels[protocol] ? (
                  <Input
                    aria-label={`${PROVIDER_PROTOCOL_LABELS[protocol]} upstream model`}
                    value={editing.protocolModels[protocol]!.upstreamModel}
                    onChange={(e) =>
                      patch({
                        protocolModels: {
                          ...editing.protocolModels,
                          [protocol]: { upstreamModel: e.target.value },
                        },
                      })
                    }
                  />
                ) : null}
              </div>
            ))}
          </Field.Group>
          <Field.Root>
            <Field.Label>Protocol selection</Field.Label>
            <Select.Root
              value={
                editing.protocolPolicy.mode === 'auto' ? 'auto' : editing.protocolPolicy.protocol
              }
              onValueChange={(next) =>
                patch({
                  protocolPolicy:
                    next === 'auto'
                      ? { mode: 'auto' }
                      : { mode: 'fixed', protocol: next as ProviderProtocol },
                })
              }
            >
              <Select.Trigger appearance="input">
                <Select.Value>
                  {editing.protocolPolicy.mode === 'auto'
                    ? 'Automatic: native protocol first, then SDK conversion'
                    : PROVIDER_PROTOCOL_LABELS[editing.protocolPolicy.protocol]}
                </Select.Value>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="auto">
                  Automatic: native protocol first, then SDK conversion
                </Select.Item>
                {Object.keys(editing.protocolModels).map((p) => (
                  <Select.Item key={p} value={p}>
                    Always use {PROVIDER_PROTOCOL_LABELS[p as ProviderProtocol]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Context window (tokens)</Field.Label>
            <Input
              type="number"
              value={editing.contextWindow ?? ''}
              placeholder="Unknown"
              onChange={(e) =>
                patch({ contextWindow: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field.Root>
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={editing.enabled}
                onCheckedChange={(v) => patch({ enabled: v === true })}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={editing.nonReasoning === true}
                onCheckedChange={(v) => patch({ nonReasoning: v === true })}
              />
              Disable reasoning controls
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={editing.webSearch === true}
                onCheckedChange={(v) => patch({ webSearch: v === true })}
              />
              Supports native Codex web search
            </label>
          </div>
          <p className="text-xs text-foreground-muted">
            Changing routes or capabilities can require an agent restart. Disabling a published
            model blocks subsequent requests to that model.
          </p>
          <div className="flex flex-wrap gap-2">
            {(['claude', 'codex'] as const).map((agent) => (
              <Button
                key={agent}
                size="sm"
                variant="secondary"
                disabled={
                  busy ||
                  Boolean(draft) ||
                  !editing.enabled ||
                  (agent === 'codex' && !agentUpstreamProtocol(editing, agent))
                }
                onClick={() =>
                  void run(async () => {
                    setTestResult(undefined);
                    const result = await (
                      await getModelGatewayClient()
                    ).testModel({ alias: editing.alias, agent });
                    setTestResult(
                      `${agent === 'claude' ? 'Claude' : 'Codex'}: HTTP ${result.status}. ${result.ok ? 'Received a valid protocol response.' : 'The request failed or returned an invalid protocol response.'}`
                    );
                  })
                }
              >
                Test {agent === 'claude' ? 'Claude' : 'Codex'} route
              </Button>
            ))}
          </div>
          {!agentUpstreamProtocol(editing, 'codex') ? (
            <p className="text-xs text-foreground-muted">{codexNativeRouteRequired}</p>
          ) : null}
          <p className="text-xs text-foreground-muted">
            Publish first. Each test sends a small model request and uses provider quota. It checks
            connectivity and response format; tool support requires separate validation.
          </p>
          {testResult ? (
            <p role="status" className="text-xs">
              {testResult}
            </p>
          ) : null}
          {!settings.value?.models.some((m) => m.id === editing.id) ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(models.filter((m) => m.id !== editing.id));
                setSelected(undefined);
              }}
            >
              Discard unpublished model
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || settings.isLoading}
          onClick={() =>
            void run(async () => {
              const preview = await (await getModelGatewayClient()).migrationPreview();
              setDraft([
                ...models,
                ...preview
                  .filter((m) => !models.some((saved) => saved.id === m.id))
                  .map((m) =>
                    models.some((saved) => saved.alias === m.alias)
                      ? { ...m, alias: `${m.alias}-${m.id.replace('import-', '')}` }
                      : m
                  ),
              ]);
            })
          }
        >
          Preview models from providers
        </Button>
        <Button
          size="sm"
          disabled={busy || !draft}
          onClick={() =>
            void run(async () => {
              const parsed = gatewayModelsSettingsSchema.parse({ version: 1, models });
              await (await getModelGatewayClient()).saveModels({ models: parsed.models });
              await client.invalidateQueries({ queryKey: ['appSettings', 'gatewayModels'] });
              await client.invalidateQueries({ queryKey: ['modelGateway'] });
              setDraft(undefined);
            })
          }
        >
          {busy ? 'Saving…' : 'Publish reviewed models'}
        </Button>
        {draft ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(undefined);
              setSelected(undefined);
            }}
          >
            Discard changes
          </Button>
        ) : null}
      </div>
      {draft ? (
        <p className="text-xs text-foreground-muted">
          Review each model’s protocols before publishing. Provider endpoints alone do not prove
          model compatibility. Existing provider-based sessions keep their saved routes.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
