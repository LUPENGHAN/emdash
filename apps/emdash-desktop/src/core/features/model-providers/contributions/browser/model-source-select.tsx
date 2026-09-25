import { Field, Select } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  defaultSourceLabel,
  isProviderCapableAgent,
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
          {defaultSourceLabel(agentId)}. Add a gateway such as new-api under Settings → Providers to
          run this agent on it.
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
            {providers.map((candidate) => (
              <Select.Item key={candidate.id} value={candidate.id}>
                {candidate.name}
              </Select.Item>
            ))}
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
                {value.sourceModel || 'Agent default'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="start" width="trigger">
              <Select.Item value="">Agent default</Select.Item>
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
