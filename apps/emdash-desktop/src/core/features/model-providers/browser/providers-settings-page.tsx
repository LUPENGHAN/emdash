import { PageLayout } from '@emdash/ui/react/patterns';
import { Button, Checkbox, Field, Input, Select, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getAgentsClient, hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import {
  CLAUDE_MODEL_ALIASES,
  defaultSourceLabel,
  describeProvider,
  formatContextWindow,
  parseContextWindow,
  PROVIDER_CAPABLE_AGENTS,
  PROVIDER_PROTOCOL_LABELS,
  PROVIDER_PROTOCOLS,
  providerModelsAuth,
  providerModelsUrl,
  providerSupportsAgent,
  type ClaudeModelRoles,
  type ModelProvider,
  type ProviderProtocol,
} from '../api';

const keyStatusQueryKey = (providerId: string) => ['modelProviderKeyStatus', providerId];

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
};

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
        description="APIs agents can run on instead of their own login: any Anthropic- or OpenAI-compatible endpoint, such as a vendor API or a gateway like new-api. Keys are kept in the OS keychain."
      />
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Your providers</h3>
        {providers.length === 0 && !editing ? (
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
                    const confirmed = await openModal('confirmActionModal', {
                      title: `Delete ${provider.name}?`,
                      description:
                        'Its key is removed from the keychain. Agents and conversations set to it will not start (they never fall back to your own login) until you pick another source: under Agent defaults below, or with “Restart with another provider…” on the conversation.',
                      confirmLabel: 'Delete',
                    });
                    if (!confirmed.success) return;
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
        ) : !editing ? (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            Add provider
          </Button>
        ) : null}
      </section>
      <AgentDefaults providers={providers} />
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
  const agents = PROVIDER_CAPABLE_AGENTS.filter(
    (agent) => providerSupportsAgent(provider, agent).ok
  );
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{provider.name}</p>
        <p className="truncate text-xs text-foreground-muted">{describeProvider(provider)}</p>
        <p className="truncate text-xs text-foreground-muted">
          {provider.models.length} models · {keyStatus?.hasKey ? 'key saved' : 'no key'} · for{' '}
          {agents.length > 0 ? agents.map((agent) => AGENT_NAMES[agent]).join(', ') : 'no agent'}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void onDelete()}>
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
  // Providers saved before protocols keep serving every protocol until one is picked.
  const [protocol, setProtocol] = useState<ProviderProtocol | 'gateway'>(
    initial ? (initial.protocol ?? 'gateway') : 'anthropic'
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [modelsUrl, setModelsUrl] = useState(initial?.modelsUrl ?? '');
  const [upstream, setUpstream] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(initial?.models ?? []);
  // Per-model context windows as typed ("1m", "256k"); blank leaves the agent's default.
  const [contexts, setContexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initial?.contextWindows ?? {}).map(([model, tokens]) => [
        model,
        formatContextWindow(tokens),
      ])
    )
  );
  const [claudeRoles, setClaudeRoles] = useState<ClaudeModelRoles>(initial?.claude ?? {});
  const [filter, setFilter] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [testState, setTestState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: keyStatus } = useQuery({
    queryKey: keyStatusQueryKey(id),
    enabled: !!initial,
    queryFn: async () => (await getAgentsClient()).modelProviderKeyStatus({ providerId: id }),
  });

  const draft: ModelProvider = {
    id,
    name: name.trim(),
    ...(protocol !== 'gateway' && { protocol }),
    baseUrl: baseUrl.trim(),
    ...(modelsUrl.trim() && { modelsUrl: modelsUrl.trim() }),
    models: selected,
  };
  const contextWindows = Object.fromEntries(
    selected.flatMap((model) => {
      const tokens = parseContextWindow(contexts[model] ?? '');
      return tokens ? [[model, tokens] as const] : [];
    })
  );
  if (Object.keys(contextWindows).length > 0) draft.contextWindows = contextWindows;
  const speaksAnthropic = protocol === 'anthropic' || protocol === 'gateway';
  const claude = speaksAnthropic ? cleanClaudeRoles(claudeRoles, selected) : undefined;
  if (claude) draft.claude = claude;
  const invalidContext = selected.some(
    (model) => (contexts[model] ?? '').trim() !== '' && !parseContextWindow(contexts[model] ?? '')
  );
  const defaultModelsUrl = baseUrl.trim()
    ? providerModelsUrl({ ...draft, modelsUrl: undefined })
    : 'Filled in from the base URL';
  const listed = [...new Set([...upstream, ...selected])].filter((model) =>
    model.toLowerCase().includes(filter.trim().toLowerCase())
  );
  const toggle = (model: string, on: boolean) =>
    setSelected((current) =>
      on ? [...new Set([...current, model])] : current.filter((m) => m !== model)
    );

  const fetchModels = async () => {
    setBusy(true);
    setTestState('Connecting…');
    const result = await (
      await getAgentsClient()
    ).listModelProviderModels({
      providerId: id,
      url: providerModelsUrl(draft),
      auth: providerModelsAuth(draft),
      apiKey: apiKey || undefined,
    });
    setBusy(false);
    if (result.success) {
      setUpstream(result.data);
      setTestState(`Connected · ${result.data.length} models upstream`);
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
      onSaved(draft);
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
        <Input value={name} placeholder="DeepSeek" onChange={(e) => setName(e.target.value)} />
      </Field.Root>
      <Field.Root>
        <Field.Label>Protocol</Field.Label>
        <Select.Root
          value={protocol}
          onValueChange={(next) => next && setProtocol(next as ProviderProtocol | 'gateway')}
        >
          <Select.Trigger appearance="input" className="w-full">
            <Select.Value>
              {protocol === 'gateway'
                ? 'Gateway (all protocols)'
                : PROVIDER_PROTOCOL_LABELS[protocol]}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="start" width="trigger">
            {PROVIDER_PROTOCOLS.map((candidate) => (
              <Select.Item key={candidate} value={candidate}>
                {PROVIDER_PROTOCOL_LABELS[candidate]}
              </Select.Item>
            ))}
            {initial && !initial.protocol ? (
              <Select.Item value="gateway">Gateway (all protocols)</Select.Item>
            ) : null}
          </Select.Content>
        </Select.Root>
        <Field.Description>
          Claude Code needs Anthropic Messages and Codex needs OpenAI Responses; OpenCode, Pi and Oh
          My Pi use any of them.
        </Field.Description>
      </Field.Root>
      <Field.Root>
        <Field.Label>Base URL</Field.Label>
        <Input
          value={baseUrl}
          placeholder={
            protocol === 'anthropic'
              ? 'https://api.example.com/anthropic'
              : 'https://api.example.com/v1'
          }
          onChange={(e) => setBaseUrl(e.target.value)}
        />
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
      <Field.Root>
        <Field.Label>Models URL</Field.Label>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={modelsUrl}
              placeholder={defaultModelsUrl}
              onChange={(e) => setModelsUrl(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !baseUrl.trim()}
            onClick={() => void fetchModels()}
          >
            Fetch models
          </Button>
        </div>
        <Field.Description>
          {testState ?? 'Leave empty to use the usual models endpoint shown above.'}
        </Field.Description>
      </Field.Root>
      <Field.Root>
        <Field.Label>
          Models ({selected.length} added{upstream.length ? ` of ${upstream.length}` : ''})
        </Field.Label>
        {upstream.length > 0 || selected.length > 0 ? (
          <>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={filter}
                  placeholder="Filter"
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected((current) => [...new Set([...current, ...listed])])}
              >
                Add all shown
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected((current) => current.filter((m) => !listed.includes(m)))}
              >
                Remove all shown
              </Button>
            </div>
            <ul className="max-h-60 overflow-y-auto rounded-md border border-border py-1">
              {listed.map((model) => (
                <li key={model} className="flex items-center gap-2 pr-2 hover:bg-background-1">
                  <label className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-sm">
                    <Checkbox
                      checked={selected.includes(model)}
                      onCheckedChange={(checked) => toggle(model, checked === true)}
                    />
                    <span className="truncate font-mono text-xs">{model}</span>
                  </label>
                  {selected.includes(model) ? (
                    <div className="w-24 shrink-0">
                      <Input
                        value={contexts[model] ?? ''}
                        placeholder="Context"
                        aria-label={`Context window of ${model}`}
                        aria-invalid={
                          (contexts[model] ?? '').trim() !== '' &&
                          !parseContextWindow(contexts[model] ?? '')
                        }
                        onChange={(e) =>
                          setContexts((current) => ({ ...current, [model]: e.target.value }))
                        }
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Field.Description>Fetch the upstream models, or type model ids below.</Field.Description>
        )}
        {selected.length > 0 ? (
          <Field.Description>
            Context: the model's context window, e.g. 1m or 256k. Codex, OpenCode, Pi, and Oh My Pi
            use it. Claude Code uses it for custom gateway models. Leave it blank to keep the
            default.
          </Field.Description>
        ) : null}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={manualModel}
              placeholder="Add a model id by hand"
              onChange={(e) => setManualModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualModel.trim()) {
                  toggle(manualModel.trim(), true);
                  setManualModel('');
                }
              }}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!manualModel.trim()}
            onClick={() => {
              toggle(manualModel.trim(), true);
              setManualModel('');
            }}
          >
            Add
          </Button>
        </div>
      </Field.Root>
      {speaksAnthropic && selected.length > 0 ? (
        <ClaudeModelRolesField models={selected} value={claudeRoles} onChange={setClaudeRoles} />
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !name.trim() || !baseUrl.trim() || invalidContext}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

const CLAUDE_ROLE_ROWS: { role: keyof Omit<ClaudeModelRoles, 'names'>; label: string }[] = [
  { role: 'model', label: 'Default' },
  { role: 'opus', label: 'Opus' },
  { role: 'sonnet', label: 'Sonnet' },
  { role: 'haiku', label: 'Haiku' },
  { role: 'fable', label: 'Fable' },
  { role: 'subagent', label: 'Subagents' },
];
const UNSET = '__unset__';

/** Keeps only roles pointing at models still on the provider, and non-blank names. */
function cleanClaudeRoles(roles: ClaudeModelRoles, models: string[]): ClaudeModelRoles | undefined {
  const clean: ClaudeModelRoles = {};
  for (const { role } of CLAUDE_ROLE_ROWS) {
    const id = roles[role];
    if (id && models.includes(id)) clean[role] = id;
  }
  const names = Object.fromEntries(
    CLAUDE_MODEL_ALIASES.flatMap((alias) => {
      const name = roles.names?.[alias]?.trim();
      return name && clean[alias] ? [[alias, name] as const] : [];
    })
  );
  if (Object.keys(names).length > 0) clean.names = names;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * Which of the provider's models Claude Code runs for the session, for each of its
 * aliases (`/model`, background work, fallback), and for subagents, with the name
 * `/model` shows for each alias.
 */
function ClaudeModelRolesField({
  models,
  value,
  onChange,
}: {
  models: string[];
  value: ClaudeModelRoles;
  onChange: (next: ClaudeModelRoles) => void;
}) {
  return (
    <Field.Root>
      <Field.Label>Claude Code models</Field.Label>
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-x-2 gap-y-1.5">
        {CLAUDE_ROLE_ROWS.map(({ role, label }) => {
          const alias = (CLAUDE_MODEL_ALIASES as readonly string[]).includes(role)
            ? (role as (typeof CLAUDE_MODEL_ALIASES)[number])
            : null;
          const current = value[role];
          return (
            <div key={role} className="contents">
              <span className="text-sm text-foreground-muted">{label}</span>
              <Select.Root
                value={current && models.includes(current) ? current : UNSET}
                onValueChange={(next) =>
                  onChange({ ...value, [role]: !next || next === UNSET ? undefined : next })
                }
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value>
                    {current && models.includes(current) ? (
                      <span className="truncate font-mono text-xs">{current}</span>
                    ) : (
                      <span className="text-foreground-passive">
                        {role === 'model' || role === 'subagent' ? 'Not set' : 'Follow default'}
                      </span>
                    )}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  <Select.Item value={UNSET}>
                    {role === 'model' || role === 'subagent' ? 'Not set' : 'Follow default'}
                  </Select.Item>
                  {models.map((model) => (
                    <Select.Item key={model} value={model}>
                      <span className="font-mono text-xs">{model}</span>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              {alias ? (
                <Input
                  value={value.names?.[alias] ?? ''}
                  placeholder="Name in /model"
                  aria-label={`${label} display name`}
                  disabled={!current}
                  onChange={(e) =>
                    onChange({ ...value, names: { ...value.names, [alias]: e.target.value } })
                  }
                />
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
      <Field.Description>
        Only conversations running Claude Code on this provider use these. Default applies when the
        conversation picks no model. An alias left on Follow default uses the conversation's model
        when that is not a Claude model. Models with a 1m context get Claude Code's 1M window;
        another context set on the conversation's model sizes it.
      </Field.Description>
    </Field.Root>
  );
}

/** Which provider (and model) each agent runs on by default; conversations can override. */
function AgentDefaults({ providers }: { providers: ModelProvider[] }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Agent defaults</h3>
        <p className="text-xs text-foreground-muted">
          New conversations use these; pick another source when creating one, or restart a
          conversation on another source from its tab menu.
        </p>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {PROVIDER_CAPABLE_AGENTS.map((agentId) => (
          <AgentDefaultRow key={agentId} agentId={agentId} providers={providers} />
        ))}
      </div>
    </section>
  );
}

const AgentDefaultRow = observer(function AgentDefaultRow({
  agentId,
  providers,
}: {
  agentId: string;
  providers: ModelProvider[];
}) {
  const { value: config, update, reset } = useAgentSettings(agentId, hostRefFromConnectionId());
  const sourceId = config?.modelSource ?? '';
  const provider = providers.find((candidate) => candidate.id === sourceId);
  const model = config?.sourceModel ?? '';

  const save = (patch: { modelSource?: string; sourceModel?: string }) => {
    const next = { ...config, ...patch };
    if (!next.extraArgs && !next.env && !next.modelSource) reset(undefined);
    else update(next);
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-28 shrink-0 text-sm">{AGENT_NAMES[agentId]}</span>
      <Select.Root
        value={sourceId}
        onValueChange={(next) =>
          save({ modelSource: next ? String(next) : undefined, sourceModel: undefined })
        }
      >
        <Select.Trigger appearance="input" className="min-w-0 flex-1">
          <Select.Value>
            {provider?.name ?? (sourceId ? 'Missing provider' : defaultSourceLabel(agentId))}
          </Select.Value>
        </Select.Trigger>
        <Select.Content align="start" width="trigger">
          <Select.Item value="">{defaultSourceLabel(agentId)}</Select.Item>
          {/* Kept selectable so the select does not reset (and clear) a deleted provider. */}
          {sourceId && !provider ? (
            <Select.Item value={sourceId}>Missing provider</Select.Item>
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
      <Select.Root
        value={model}
        disabled={!provider}
        onValueChange={(next) =>
          save({ modelSource: sourceId, sourceModel: next ? String(next) : undefined })
        }
      >
        <Select.Trigger appearance="input" className="min-w-0 flex-1">
          <Select.Value>{provider ? model || firstModelLabel(provider) : '—'}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start" width="trigger">
          <Select.Item value="">{provider ? firstModelLabel(provider) : '—'}</Select.Item>
          {model && !provider?.models.includes(model) ? (
            <Select.Item value={model}>{model}</Select.Item>
          ) : null}
          {(provider?.models ?? []).map((id) => (
            <Select.Item key={id} value={id}>
              {id}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  );
});

function firstModelLabel(provider: ModelProvider): string {
  return provider.models[0] ? `First model (${provider.models[0]})` : 'Agent default model';
}
