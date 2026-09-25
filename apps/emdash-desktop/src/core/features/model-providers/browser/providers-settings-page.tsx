import { PageLayout } from '@emdash/ui/react/patterns';
import { Button, Field, Input, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { ModelProvider } from '../api';

const keyStatusQueryKey = (providerId: string) => ['modelProviderKeyStatus', providerId];

export function ProvidersSettingsPage() {
  const { value, update } = useAppSettingsKey('modelProviders');
  const providers = value?.providers ?? [];
  const [editing, setEditing] = useState<ModelProvider | 'new' | null>(null);

  const saveProviders = (next: ModelProvider[]) => update({ providers: next });

  return (
    <div className="space-y-8 pb-4">
      <PageLayout.Header
        sticky
        title="Providers"
        description="OpenAI/Anthropic-compatible gateways (such as new-api) that agents can run on instead of their own login. Pick one per agent under Agents. Keys are kept in the OS keychain."
      />
      {providers.length === 0 && editing === null ? (
        <p className="text-sm text-foreground-muted">No providers yet.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {providers.map((provider) =>
          editing !== 'new' && editing?.id === provider.id ? (
            <li key={provider.id}>
              <ProviderForm
                initial={provider}
                onCancel={() => setEditing(null)}
                onSaved={(saved) => {
                  saveProviders(providers.map((p) => (p.id === saved.id ? saved : p)));
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li key={provider.id}>
              <ProviderRow
                provider={provider}
                onEdit={() => setEditing(provider)}
                onDelete={async () => {
                  await (
                    await getAgentsClient()
                  ).clearModelProviderKey({ providerId: provider.id });
                  saveProviders(providers.filter((p) => p.id !== provider.id));
                }}
              />
            </li>
          )
        )}
      </ul>
      {editing === 'new' ? (
        <ProviderForm
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            saveProviders([...providers, saved]);
            setEditing(null);
          }}
        />
      ) : (
        <Button variant="secondary" onClick={() => setEditing('new')}>
          Add provider
        </Button>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ModelProvider;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { data: keyStatus } = useQuery({
    queryKey: keyStatusQueryKey(provider.id),
    queryFn: async () =>
      (await getAgentsClient()).modelProviderKeyStatus({ providerId: provider.id }),
  });
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{provider.name}</p>
        <p className="truncate text-xs text-foreground-muted">
          {provider.baseUrl} · {provider.models.length} models ·{' '}
          {keyStatus?.hasKey ? 'key saved' : 'no key'}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

function ProviderForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: ModelProvider;
  onCancel: () => void;
  onSaved: (provider: ModelProvider) => void;
}) {
  const queryClient = useQueryClient();
  const [id] = useState(() => initial?.id ?? crypto.randomUUID().slice(0, 8));
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'http://127.0.0.1:3000');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>(initial?.models ?? []);
  const [testState, setTestState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: keyStatus } = useQuery({
    queryKey: keyStatusQueryKey(id),
    enabled: !!initial,
    queryFn: async () => (await getAgentsClient()).modelProviderKeyStatus({ providerId: id }),
  });

  const test = async () => {
    setBusy(true);
    setTestState('Connecting…');
    const result = await (
      await getAgentsClient()
    ).listModelProviderModels({ providerId: id, baseUrl, apiKey: apiKey || undefined });
    setBusy(false);
    if (result.success) {
      setModels(result.data);
      setTestState(`Connected · ${result.data.length} models`);
    } else {
      setTestState(`Failed: ${result.error.message}`);
    }
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setBusy(true);
    try {
      if (apiKey.trim()) {
        await (await getAgentsClient()).setModelProviderKey({ providerId: id, apiKey });
        await queryClient.invalidateQueries({ queryKey: keyStatusQueryKey(id) });
      }
      onSaved({ id, name: name.trim(), baseUrl: baseUrl.trim(), models });
    } catch (error) {
      toast.error(`Could not save the provider: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <Field.Root>
        <Field.Label>Name</Field.Label>
        <Input value={name} placeholder="new-api" onChange={(e) => setName(e.target.value)} />
      </Field.Root>
      <Field.Root>
        <Field.Label>Base URL</Field.Label>
        <Input
          value={baseUrl}
          placeholder="http://127.0.0.1:3000"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Field.Description>
          Gateway root. Claude Code uses its Anthropic endpoint; other agents use {'/v1'}.
        </Field.Description>
      </Field.Root>
      <Field.Root>
        <Field.Label>API key</Field.Label>
        <Input
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={keyStatus?.hasKey ? 'Saved — type to replace' : 'sk-…'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field.Root>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy || !baseUrl.trim()} onClick={test}>
          Test & load models
        </Button>
        <span className="truncate text-xs text-foreground-muted">
          {testState ?? (models.length ? `${models.length} models` : 'No models loaded yet')}
        </span>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !name.trim() || !baseUrl.trim()}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
