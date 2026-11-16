import { ComboboxPopover } from '@emdash/ui/react/components';
import { Button, Field, Select } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  catalogSourceId,
  modelAvailableForAgent,
  upstreamProtocol,
} from '@core/features/model-gateway/api/model-catalog';
import {
  defaultSourceLabel,
  isProviderCapableAgent,
  type ModelSourceValue,
} from '@core/features/model-providers/api';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { useModelSource } from '../../api/browser/use-model-source';

const OWN_LOGIN = '__own_login__';

/** Daily selection exposes access mode and a public model, independently of its provider. */
export const ModelSourceSelect = observer(function ModelSourceSelect({
  agentId,
  value,
  onChange,
  remote = false,
  showReset = true,
}: {
  agentId: string | null | undefined;
  remote?: boolean;
  showReset?: boolean;
  value: ModelSourceValue;
  onChange: (value: ModelSourceValue) => void;
}) {
  const { value: settings } = useAppSettingsKey('modelProviders');
  const { value: catalog } = useAppSettingsKey('gatewayModels');
  const effective = useModelSource(agentId, value, remote);
  if (!agentId) return null;
  if (!isProviderCapableAgent(agentId))
    return (
      <Field.Root>
        <Field.Label>Connection</Field.Label>
        <Field.Description>
          This agent uses its own configuration. Gateway access is unavailable until its custom API
          integration is supported.
        </Field.Description>
      </Field.Root>
    );
  const source = effective?.modelSource ?? null;
  const model = effective?.sourceModel;
  const official = remote
    ? []
    : (settings?.providers ?? []).filter((p) => p.account?.agent === agentId);
  const legacy = source && source !== catalogSourceId && !official.some((p) => p.id === source);
  const models = (catalog?.models ?? []).filter((m) =>
    modelAvailableForAgent(
      m,
      settings?.providers.find((p) => p.id === m.providerId),
      agentId
    )
  );
  const selected = source === catalogSourceId ? catalogSourceId : legacy ? source : OWN_LOGIN;
  const label =
    source === catalogSourceId
      ? 'Gateway'
      : legacy
        ? 'Saved provider configuration'
        : defaultSourceLabel(agentId);
  return (
    <>
      <Field.Root>
        <Field.Label>Connection</Field.Label>
        <Select.Root
          value={selected}
          onValueChange={(next) =>
            onChange(
              next === OWN_LOGIN
                ? { modelSource: null }
                : {
                    modelSource: String(next),
                    ...(next === catalogSourceId && {
                      sourceModel:
                        model && models.some((m) => m.alias === model) ? model : undefined,
                    }),
                  }
            )
          }
        >
          <Select.Trigger appearance="input" className="w-full">
            <Select.Value>{label}</Select.Value>
          </Select.Trigger>
          <Select.Content align="start" width="trigger">
            <Select.Item value={OWN_LOGIN}>{defaultSourceLabel(agentId)}</Select.Item>
            <Select.Item value={catalogSourceId} disabled={remote}>
              Gateway{remote ? ' (local agents only)' : ''}
            </Select.Item>
            {legacy && source ? (
              <Select.Item value={source}>Saved provider configuration</Select.Item>
            ) : null}
          </Select.Content>
        </Select.Root>
        {value.modelSource === undefined ? (
          <Field.Description>Following the agent default.</Field.Description>
        ) : null}
        {showReset ? (
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            Restore agent default
          </Button>
        ) : null}
      </Field.Root>
      {source !== catalogSourceId && !legacy && official.length > 0 ? (
        <Field.Root>
          <Field.Label>Official account</Field.Label>
          <Select.Root
            value={source ?? ''}
            onValueChange={(next) => onChange({ modelSource: next ? String(next) : null })}
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value>
                {official.find((p) => p.id === source)?.name ?? 'Default sign-in'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content width="trigger">
              <Select.Item value="">Default sign-in</Select.Item>
              {official.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  {p.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field.Root>
      ) : null}
      {source === catalogSourceId ? (
        <Field.Root>
          <Field.Label>Gateway model</Field.Label>
          <ComboboxPopover
            items={models}
            value={model}
            itemToKey={(m) => m.alias}
            itemToLabel={(m) => m.name}
            filter={(m, query) =>
              `${m.name} ${m.alias}`.toLowerCase().includes(query.toLowerCase())
            }
            onValueChange={(alias) =>
              onChange({ modelSource: catalogSourceId, sourceModel: alias })
            }
            renderTrigger={(m) =>
              m ? `${m.name} · ${m.alias}` : model ? `${model} (unavailable)` : 'Select a model'
            }
            renderItem={(m) => (
              <span>
                {m.name}
                <span className="ml-2 text-xs text-foreground-muted">{m.alias}</span>
              </span>
            )}
            searchPlaceholder="Search gateway models…"
            appearance="input"
            className="w-full"
            disabled={remote}
          />
          <Field.Description>
            {models.length
              ? 'Protocols and upstream providers are managed in Settings → Providers → Gateway models.'
              : 'Publish a compatible model in Settings → Providers → Gateway models.'}
          </Field.Description>
          {agentId === 'claude' &&
          models.some((m) => upstreamProtocol(m, 'anthropic') !== 'anthropic') ? (
            <Field.Description>
              This catalog uses protocol conversion. Claude prompt caching and experimental tool
              features are disabled for this session.
            </Field.Description>
          ) : null}
        </Field.Root>
      ) : null}
    </>
  );
});
