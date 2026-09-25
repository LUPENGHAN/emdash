import {
  Button,
  Collapsible,
  Field,
  Input,
  Label,
  Select,
  Tooltip,
} from '@emdash/ui/react/primitives';
import { useForm } from '@tanstack/react-form';
import { ChevronRight, Info, RotateCcw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useState } from 'react';
import { defaultSourceLabel, isProviderCapableAgent } from '@core/features/model-providers/api';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import {
  EnvironmentVariableInputs,
  type EnvironmentVariableEntry,
} from '@core/primitives/environment-variables/browser/environment-variable-inputs';
import { log } from '@core/primitives/logging/browser/logger';
import { cn } from '@core/primitives/styling/browser/cn';

const FieldTooltip: React.FC<{ content: string }> = ({ content }) => (
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label="More information"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="top" className="max-w-[200px] text-xs">
        {content}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
);

export interface InstalledAgentContentProps {
  agentId: string;
  /** Set for agents on a remote machine, where local providers do not apply. */
  connectionId?: string;
  storedConfig: ProviderCustomConfig | undefined;
  isOverridden: boolean;
  isLoading: boolean;
  update: (
    cfg: ProviderCustomConfig,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
  reset: (
    val?: undefined,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
}

function makeDefaultValues(cfg: ProviderCustomConfig | undefined) {
  return {
    extraArgs: cfg?.extraArgs ?? '',
    envEntries: cfg?.env
      ? (Object.entries(cfg.env).map(([key, value]) => ({
          key,
          value,
        })) as EnvironmentVariableEntry[])
      : ([] as EnvironmentVariableEntry[]),
  };
}

export const InstalledAgentContent = observer(function InstalledAgentContent({
  agentId,
  connectionId,
  storedConfig,
  isOverridden,
  isLoading,
  update,
  reset,
}: InstalledAgentContentProps) {
  const [open, setOpen] = useState(false);

  const form = useForm({ defaultValues: makeDefaultValues(storedConfig) });

  // Re-sync form when external config changes (e.g. after a reset from outside).
  useEffect(() => {
    if (isLoading) return;
    const next = makeDefaultValues(storedConfig);
    form.setFieldValue('extraArgs', next.extraArgs);
    form.setFieldValue('envEntries', next.envEntries);
  }, [isLoading, storedConfig, isOverridden, form]);

  const commit = useCallback(
    (entries?: EnvironmentVariableEntry[]) => {
      const { extraArgs, envEntries: currentEntries } = form.state.values;
      const envEntries = entries ?? currentEntries;
      const envRecord: Record<string, string> = {};
      for (const { key, value } of envEntries) {
        const k = key.trim();
        if (k && /^[A-Za-z_]\w*$/.test(k)) {
          envRecord[k] = value;
        }
      }

      const isAtDefaults =
        extraArgs.trim() === '' &&
        envEntries.every((e) => !e.key.trim()) &&
        !storedConfig?.modelSource;

      if (isAtDefaults) {
        reset(undefined, {
          onError: (err) => log.error('Failed to reset agent config:', err),
        });
      } else {
        const config: ProviderCustomConfig = {
          ...(storedConfig ?? {}),
          extraArgs: extraArgs.trim() || undefined,
          env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
        };
        update(config, {
          onError: (err) => log.error('Failed to save agent config:', err),
        });
      }
    },
    [form, storedConfig, reset, update]
  );

  const handleResetToDefaults = useCallback(() => {
    form.setFieldValue('extraArgs', '');
    form.setFieldValue('envEntries', []);
    reset(undefined, {
      onError: (err) => log.error('Failed to reset agent config:', err),
    });
  }, [form, reset]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2">
      {connectionId ? null : (
        <ModelSourceFields
          agentId={agentId}
          storedConfig={storedConfig}
          onChange={(patch) => {
            const next = { ...(storedConfig ?? {}), ...patch };
            const empty = !next.extraArgs && !next.env && !next.modelSource;
            if (empty) {
              reset(undefined, {
                onError: (err) => log.error('Failed to reset agent config:', err),
              });
            } else {
              update(next, { onError: (err) => log.error('Failed to save agent config:', err) });
            }
          }}
        />
      )}
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger
          hideChevron
          type="button"
          className="flex w-full items-center justify-between rounded-md py-2 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <span className="flex h-6 items-center gap-1.5">
            <Label>Advanced settings</Label>
            <ChevronRight
              className={cn('size-3.5', 'transition-transform', open ? 'rotate-90' : '')}
            />
          </span>
          {isOverridden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 px-2 text-xs"
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                handleResetToDefaults();
              }}
            >
              <RotateCcw className="size-3.5" />
              Reset to defaults
            </Button>
          )}
        </Collapsible.Trigger>

        <Collapsible.Panel className="space-y-4 rounded-lg border p-3">
          {/* Additional parameters */}
          <form.Field name="extraArgs">
            {(field) => (
              <Field.Root>
                <div className="flex items-center gap-2">
                  <Label htmlFor="sheet-extraArgs">Additional parameters</Label>
                  <FieldTooltip content="Extra flags appended to the command (e.g. --enable-all-github-mcp-tools)" />
                </div>
                <Input
                  id="sheet-extraArgs"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={() => commit()}
                  placeholder="e.g. --enable-all-github-mcp-tools"
                  className="font-mono text-sm"
                />
              </Field.Root>
            )}
          </form.Field>

          {/* Environment variables */}
          <form.Field name="envEntries">
            {(field) => (
              <Field.Root>
                <div className="flex items-center gap-2">
                  <Label>Environment variables</Label>
                  <FieldTooltip content="Environment variables set when running the agent" />
                </div>
                <EnvironmentVariableInputs
                  entries={field.state.value}
                  onChange={field.handleChange}
                  onCommit={commit}
                />
              </Field.Root>
            )}
          </form.Field>

          {isOverridden && (
            <div className="rounded-md border border-border-warning bg-background-warning px-3 py-2 text-xs text-foreground-warning">
              Custom configuration is applied
            </div>
          )}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
});

/**
 * Which login/config the agent runs on: its own (official subscription or its own config)
 * or a model provider configured under Settings → Providers, plus that provider's model.
 */
const ModelSourceFields = observer(function ModelSourceFields({
  agentId,
  storedConfig,
  onChange,
}: {
  agentId: string;
  storedConfig: ProviderCustomConfig | undefined;
  onChange: (patch: Pick<ProviderCustomConfig, 'modelSource' | 'sourceModel'>) => void;
}) {
  const { value } = useAppSettingsKey('modelProviders');
  const providers = value?.providers ?? [];

  if (agentId === 'cursor') {
    return (
      <Field.Root className="mb-3">
        <Label>Source</Label>
        <p className="text-sm text-foreground-muted">
          {defaultSourceLabel(agentId)}. The Cursor CLI cannot run on a custom provider.
        </p>
      </Field.Root>
    );
  }
  if (!isProviderCapableAgent(agentId)) return null;

  const sourceId = storedConfig?.modelSource ?? '';
  const provider = providers.find((candidate) => candidate.id === sourceId);
  const model = storedConfig?.sourceModel ?? '';

  return (
    <div className="mb-3 space-y-3">
      <Field.Root>
        <Label>Source</Label>
        <Select.Root
          value={sourceId}
          onValueChange={(next) =>
            onChange({ modelSource: next || undefined, sourceModel: undefined })
          }
        >
          <Select.Trigger appearance="input" className="w-full">
            <Select.Value placeholder={defaultSourceLabel(agentId)}>
              {provider?.name ?? (sourceId ? 'Missing provider' : defaultSourceLabel(agentId))}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="start" width="trigger">
            <Select.Item value="">{defaultSourceLabel(agentId)}</Select.Item>
            {providers.map((candidate) => (
              <Select.Item key={candidate.id} value={candidate.id}>
                {candidate.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {providers.length === 0 ? (
          <Field.Description>
            Add a gateway under Settings → Providers to use it here.
          </Field.Description>
        ) : null}
      </Field.Root>
      {provider ? (
        <Field.Root>
          <Label>Model</Label>
          <Select.Root
            value={model}
            onValueChange={(next) =>
              onChange({ modelSource: sourceId, sourceModel: next || undefined })
            }
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value placeholder="Agent default">{model || 'Agent default'}</Select.Value>
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
          {provider.models.length === 0 ? (
            <Field.Description>
              Load the provider&apos;s models with “Test &amp; load models” in Settings → Providers.
            </Field.Description>
          ) : null}
        </Field.Root>
      ) : null}
    </div>
  );
});
