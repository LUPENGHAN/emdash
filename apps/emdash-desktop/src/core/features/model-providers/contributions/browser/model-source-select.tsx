import { Field, Select } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  defaultSourceLabel,
  isProviderCapableAgent,
  providerSupportsAgent,
  type ModelSourceValue,
} from '@core/features/model-providers/api';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';

const AGENT_DEFAULT = '__agent_default__';
const OWN_LOGIN = '__own_login__';

/**
 * Per-conversation source picker. Hidden for agents that cannot run on a provider; with
 * no provider configured it only says where to add one.
 */
export const ModelSourceSelect = observer(function ModelSourceSelect({
  agentId,
  value,
  onChange,
}: {
  agentId: string | null | undefined;
  value: ModelSourceValue;
  onChange: (value: ModelSourceValue) => void;
}) {
  const { value: settings } = useAppSettingsKey('modelProviders');
  const providers = settings?.providers ?? [];
  if (!agentId || !isProviderCapableAgent(agentId)) return null;
  if (providers.length === 0) {
    return (
      <Field.Root>
        <Field.Label>Source</Field.Label>
        <Field.Description>
          The agent’s default source (Settings → Providers → Agent defaults). Add a provider there
          to run this agent on another API.
        </Field.Description>
      </Field.Root>
    );
  }

  const selected =
    value.modelSource === undefined
      ? AGENT_DEFAULT
      : value.modelSource === null
        ? OWN_LOGIN
        : value.modelSource;
  const provider = providers.find((candidate) => candidate.id === value.modelSource);
  const label =
    selected === AGENT_DEFAULT
      ? 'Agent default'
      : selected === OWN_LOGIN
        ? defaultSourceLabel(agentId)
        : (provider?.name ?? 'Missing provider');

  return (
    <>
      <Field.Root>
        <Field.Label>Source</Field.Label>
        <Select.Root
          value={selected}
          onValueChange={(next) =>
            onChange(
              next === AGENT_DEFAULT
                ? {}
                : next === OWN_LOGIN
                  ? { modelSource: null }
                  : { modelSource: String(next) }
            )
          }
        >
          <Select.Trigger appearance="input" className="w-full">
            <Select.Value placeholder="Agent default">{label}</Select.Value>
          </Select.Trigger>
          <Select.Content align="start" width="trigger">
            <Select.Item value={AGENT_DEFAULT}>Agent default</Select.Item>
            <Select.Item value={OWN_LOGIN}>{defaultSourceLabel(agentId)}</Select.Item>
            {typeof value.modelSource === 'string' && !provider ? (
              <Select.Item value={value.modelSource}>Missing provider</Select.Item>
            ) : null}
            {providers.map((candidate) => {
              const support = providerSupportsAgent(candidate, agentId);
              return (
                <Select.Item key={candidate.id} value={candidate.id} disabled={!support.ok}>
                  {candidate.name}
                  {support.ok ? null : (
                    <span className="ml-2 text-xs text-foreground-muted">({support.reason})</span>
                  )}
                </Select.Item>
              );
            })}
          </Select.Content>
        </Select.Root>
      </Field.Root>
      {provider && provider.models.length > 0 ? (
        <Field.Root>
          <Field.Label>Provider model</Field.Label>
          <Select.Root
            value={value.sourceModel ?? ''}
            onValueChange={(next) =>
              onChange({ modelSource: provider.id, sourceModel: next ? String(next) : undefined })
            }
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value placeholder="Agent default">
                {value.sourceModel || `First model (${provider.models[0]})`}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="start" width="trigger">
              <Select.Item value="">First model ({provider.models[0]})</Select.Item>
              {value.sourceModel && !provider.models.includes(value.sourceModel) ? (
                <Select.Item value={value.sourceModel}>{value.sourceModel}</Select.Item>
              ) : null}
              {provider.models.map((id) => (
                <Select.Item key={id} value={id}>
                  {id}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field.Root>
      ) : null}
    </>
  );
});
