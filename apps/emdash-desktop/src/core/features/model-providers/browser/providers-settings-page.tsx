import { PageLayout } from '@emdash/ui/react/patterns';
import {
  Button,
  Checkbox,
  Field,
  Input,
  Popover,
  Select,
  Switch,
  toast,
} from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getAgentsClient, hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { GatewayModelsPanel } from '@core/features/model-gateway/contributions/browser/models-panel';
import { GatewayProvidersPanel } from '@core/features/model-gateway/contributions/browser/providers-panel';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import { copyTextToClipboard } from '@core/primitives/desktop-host/browser/host-client';
import {
  CLAUDE_MODEL_ALIASES,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_REASONING,
  defaultAfterRemoving,
  normalizeCodexReasoningLevels,
  OFFICIAL_ACCOUNT_AGENTS,
  OFFICIAL_ACCOUNT_LABELS,
  type OfficialAccountAgent,
  describeProvider,
  formatContextWindow,
  parseContextWindow,
  PROVIDER_CAPABLE_AGENTS,
  PROVIDER_PROTOCOL_LABELS,
  PROVIDER_PROTOCOLS,
  providerEndpoints,
  providerModelsAuth,
  providerModelsUrl,
  providerSupportsAgent,
  type ClaudeModelRoles,
  type CodexReasoning,
  type CodexReasoningEffort,
  type ModelProvider,
  type ModelSourceValue,
  type ProviderProtocol,
} from '../api';
import { ModelSourceSelect } from '../contributions/browser/model-source-select';
import {
  applyContextWindowToSelected,
  canApplyContextToSelected,
  claudeRolesForEveryRole,
} from './provider-form-bulk';
import { ProviderTransfer } from './provider-transfer';

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
  const apis = providers.filter((provider) => !provider.account);
  const [editing, setEditing] = useState<ModelProvider | 'new' | null>(null);

  const saveProviders = (next: ModelProvider[]) => update({ providers: next });

  return (
    <div className="space-y-8 pb-4">
      <PageLayout.Header
        sticky
        title="Providers"
        description="Configure providers once. Anthropic Messages, OpenAI Chat Completions and Responses share the local router. Credentials stay in secure storage."
      />
      <GatewayModelsPanel />
      <GatewayProvidersPanel />
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Your providers</h3>
        {apis.length === 0 && !editing ? (
          <p className="text-sm text-foreground-muted">No providers yet.</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {apis.map((provider) =>
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
                    for (const protocol of PROVIDER_PROTOCOLS)
                      await (
                        await getAgentsClient()
                      ).clearModelProviderKey({ providerId: provider.id, protocol });
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
        {!editing ? <ProviderTransfer providers={apis} /> : null}
      </section>
      <OfficialAccounts providers={providers} saveProviders={saveProviders} />
      <AgentDefaults />
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
          Local router · {provider.models.length} models ·{' '}
          {keyStatus?.hasKey ? 'key saved' : 'no key'} · for{' '}
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
  const [protocol, setProtocol] = useState<ProviderProtocol | 'multi'>(
    initial && !initial.endpoints && initial.protocol ? initial.protocol : 'multi'
  );
  const [endpoints, setEndpoints] = useState<Partial<Record<ProviderProtocol, string>>>(() => {
    if (initial?.endpoints) return initial.endpoints;
    if (!initial) return { anthropic: '', 'openai-chat': '', 'openai-responses': '' };
    if (initial.protocol) return {};
    const existing = providerEndpoints(initial);
    return {
      anthropic: existing.anthropic?.url,
      'openai-chat': existing.openai?.url,
      'openai-responses': existing.openai?.url,
    };
  });
  const [preferredProtocol, setPreferredProtocol] = useState<ProviderProtocol | undefined>(
    initial?.preferredProtocol
  );
  const activeEndpoints = Object.fromEntries(
    Object.entries(endpoints)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key, value.trim()])
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const multiBaseUrl =
    baseUrl.trim() ||
    activeEndpoints['openai-chat'] ||
    activeEndpoints['openai-responses'] ||
    activeEndpoints.anthropic ||
    '';
  const hasBaseUrl =
    protocol === 'multi'
      ? Object.keys(activeEndpoints).length > 0 &&
        Object.values(activeEndpoints).every((value) => value || baseUrl.trim())
      : Boolean(baseUrl.trim());
  const [apiKey, setApiKey] = useState('');
  const [protocolKeys, setProtocolKeys] = useState<Partial<Record<ProviderProtocol, string>>>({});
  const storedKeys = useQuery({
    queryKey: ['modelProviderKeys', id],
    queryFn: async () => (await getAgentsClient()).readModelProviderKeys({ providerId: id }),
    enabled: Boolean(initial),
    gcTime: 0,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!storedKeys.data) return;
    setApiKey(storedKeys.data.shared ?? '');
    setProtocolKeys(
      Object.fromEntries(
        Object.entries(storedKeys.data.protocols).map(([key, value]) => [key, value ?? ''])
      )
    );
  }, [storedKeys.data]);
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
  const [nonReasoning, setNonReasoning] = useState<string[]>(initial?.nonReasoningModels ?? []);
  const [webSearch, setWebSearch] = useState<string[]>(initial?.webSearchModels ?? []);
  const [codexReasoning, setCodexReasoning] = useState<CodexReasoning | undefined>(
    initial?.codexReasoning
  );
  const [codexReasoningByModel, setCodexReasoningByModel] = useState<
    Record<string, CodexReasoning>
  >(initial?.codexReasoningByModel ?? {});
  const [claudeRoles, setClaudeRoles] = useState<ClaudeModelRoles>(initial?.claude ?? {});
  const [filter, setFilter] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [bulkContext, setBulkContext] = useState('');
  const [testState, setTestState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draft: ModelProvider = {
    ...(initial?.modelAliases && { modelAliases: initial.modelAliases }),
    id,
    name: name.trim(),
    ...(protocol !== 'multi' && { protocol }),
    ...(protocol === 'multi' && {
      endpoints: activeEndpoints,
      ...(preferredProtocol && { preferredProtocol }),
    }),
    baseUrl: protocol === 'multi' ? multiBaseUrl : baseUrl.trim(),
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
  const nonReasoningModels = nonReasoning.filter((model) => selected.includes(model));
  if (nonReasoningModels.length > 0) draft.nonReasoningModels = nonReasoningModels;
  const webSearchModels = webSearch.filter((model) => selected.includes(model));
  if (webSearchModels.length > 0) draft.webSearchModels = webSearchModels;
  const speaksAnthropic =
    protocol === 'anthropic' ||
    (protocol === 'multi' && Object.hasOwn(activeEndpoints, 'anthropic'));
  const speaksResponses =
    protocol === 'openai-responses' ||
    (protocol === 'multi' && Object.hasOwn(activeEndpoints, 'openai-responses'));
  const claude = speaksAnthropic ? cleanClaudeRoles(claudeRoles, selected) : undefined;
  if (claude) draft.claude = claude;
  if (speaksResponses && codexReasoning) draft.codexReasoning = codexReasoning;
  const ownEfforts = Object.fromEntries(
    Object.entries(codexReasoningByModel).filter(([model]) => selected.includes(model))
  );
  if (speaksResponses && Object.keys(ownEfforts).length > 0) {
    draft.codexReasoningByModel = ownEfforts;
  }
  const providerEfforts = codexReasoning ?? DEFAULT_CODEX_REASONING;
  const invalidContext = selected.some(
    (model) => (contexts[model] ?? '').trim() !== '' && !parseContextWindow(contexts[model] ?? '')
  );
  const bulkContextInvalid = bulkContext.trim() !== '' && parseContextWindow(bulkContext) === null;
  const defaultModelsUrl = hasBaseUrl
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
      apiKey:
        protocolKeys[
          draft.endpoints
            ? providerEndpoints(draft).openai
              ? Object.hasOwn(draft.endpoints, 'openai-chat')
                ? 'openai-chat'
                : 'openai-responses'
              : 'anthropic'
            : (protocol as ProviderProtocol)
        ] ||
        apiKey ||
        undefined,
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
    if (!name.trim() || !hasBaseUrl) return;
    setBusy(true);
    try {
      const client = await getAgentsClient();
      if (apiKey.trim()) await client.setModelProviderKey({ providerId: id, apiKey });
      else await client.clearModelProviderKey({ providerId: id });
      for (const candidate of PROVIDER_PROTOCOLS) {
        const key = protocolKeys[candidate]?.trim();
        if (key)
          await client.setModelProviderKey({ providerId: id, protocol: candidate, apiKey: key });
        else await client.clearModelProviderKey({ providerId: id, protocol: candidate });
      }
      await queryClient.invalidateQueries({ queryKey: keyStatusQueryKey(id) });
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
          onValueChange={(next) => next && setProtocol(next as ProviderProtocol | 'multi')}
        >
          <Select.Trigger appearance="input" className="w-full">
            <Select.Value>
              {protocol === 'multi' ? 'Multiple protocols' : PROVIDER_PROTOCOL_LABELS[protocol]}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="start" width="trigger">
            {PROVIDER_PROTOCOLS.map((candidate) => (
              <Select.Item key={candidate} value={candidate}>
                {PROVIDER_PROTOCOL_LABELS[candidate]}
              </Select.Item>
            ))}
            <Select.Item value="multi">Multiple protocols</Select.Item>
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
          placeholder="https://api.example.com"
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        {protocol === 'multi' ? (
          <Field.Description>
            Shared base for enabled protocols. Override individual URLs below when needed.
          </Field.Description>
        ) : null}
      </Field.Root>
      {protocol === 'multi' ? (
        <>
          <div className="space-y-3">
            <p className="text-sm font-medium">Protocol URLs</p>
            {PROVIDER_PROTOCOLS.map((candidate) => (
              <div key={candidate} className="space-y-2">
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={Object.hasOwn(activeEndpoints, candidate)}
                    onCheckedChange={(checked) => {
                      setEndpoints((current) => {
                        const next = { ...current };
                        if (checked === true) next[candidate] = '';
                        else delete next[candidate];
                        return next;
                      });
                      if (checked !== true && preferredProtocol === candidate)
                        setPreferredProtocol(undefined);
                    }}
                  />
                  <span>{PROVIDER_PROTOCOL_LABELS[candidate]}</span>
                </label>
                {Object.hasOwn(activeEndpoints, candidate) ? (
                  <Input
                    aria-label={PROVIDER_PROTOCOL_LABELS[candidate] + ' URL'}
                    value={endpoints[candidate] ?? ''}
                    placeholder="Use Base URL"
                    onChange={(event) =>
                      setEndpoints((current) => ({ ...current, [candidate]: event.target.value }))
                    }
                  />
                ) : null}
              </div>
            ))}
          </div>
          <Field.Root>
            <Field.Label>Default launch protocol</Field.Label>
            <Select.Root
              value={preferredProtocol ?? 'auto'}
              onValueChange={(value) =>
                setPreferredProtocol(value === 'auto' ? undefined : (value as ProviderProtocol))
              }
            >
              <Select.Trigger appearance="input">
                <Select.Value>
                  {preferredProtocol ? PROVIDER_PROTOCOL_LABELS[preferredProtocol] : 'Automatic'}
                </Select.Value>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="auto">Automatic</Select.Item>
                {PROVIDER_PROTOCOLS.filter((candidate) =>
                  Object.hasOwn(activeEndpoints, candidate)
                ).map((candidate) => (
                  <Select.Item key={candidate} value={candidate}>
                    {PROVIDER_PROTOCOL_LABELS[candidate]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Field.Description>
              Used by new OpenCode, Pi and Oh My Pi sessions. Claude Code uses Messages; Codex uses
              Responses. Changing this setting requires restarting existing sessions.
            </Field.Description>
          </Field.Root>
        </>
      ) : null}
      <Field.Root>
        <Field.Label>Default API key</Field.Label>
        <div className="flex gap-2">
          <Input
            type="text"
            autoComplete="off"
            value={apiKey}
            placeholder="sk-…"
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!apiKey}
            onClick={() =>
              void copyTextToClipboard(apiKey).catch(() => toast.error('Could not copy the key.'))
            }
          >
            Copy
          </Button>
        </div>
        <Field.Description>
          Shared by all protocols unless overridden below. Keys are visible and stored encrypted.
        </Field.Description>
      </Field.Root>
      {PROVIDER_PROTOCOLS.filter((candidate) =>
        protocol === 'multi' ? Object.hasOwn(activeEndpoints, candidate) : candidate === protocol
      ).map((candidate) => (
        <Field.Root key={candidate}>
          <Field.Label>{PROVIDER_PROTOCOL_LABELS[candidate]} API key</Field.Label>
          <div className="flex gap-2">
            <Input
              type="text"
              aria-label={PROVIDER_PROTOCOL_LABELS[candidate] + ' API key'}
              autoComplete="off"
              value={protocolKeys[candidate] ?? ''}
              placeholder="Use default API key"
              onChange={(event) =>
                setProtocolKeys((current) => ({ ...current, [candidate]: event.target.value }))
              }
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!protocolKeys[candidate] && !apiKey}
              onClick={() =>
                void copyTextToClipboard(protocolKeys[candidate] || apiKey).catch(() =>
                  toast.error('Could not copy the key.')
                )
              }
            >
              Copy
            </Button>
          </div>
        </Field.Root>
      ))}
      {storedKeys.error ? (
        <p role="alert" className="text-destructive text-xs">
          Could not load saved keys.
        </p>
      ) : null}
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
            disabled={busy || !hasBaseUrl}
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
          Upstream model suggestions ({selected.length} added
          {upstream.length ? ` of ${upstream.length}` : ''})
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
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={bulkContext}
                  placeholder="1m"
                  aria-label="Context window for selected models"
                  aria-invalid={bulkContextInvalid}
                  onChange={(event) => setBulkContext(event.target.value)}
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!canApplyContextToSelected(selected.length, bulkContext)}
                onClick={() =>
                  setContexts((current) =>
                    applyContextWindowToSelected(current, selected, bulkContext)
                  )
                }
              >
                Apply to selected
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
                    <label
                      className="flex shrink-0 items-center gap-1 text-xs text-foreground-muted"
                      title="Offer thinking levels for this model (Pi, Oh My Pi). Turn off for models that reject reasoning settings."
                    >
                      <Checkbox
                        checked={!nonReasoning.includes(model)}
                        onCheckedChange={(checked) =>
                          setNonReasoning((current) =>
                            checked === true
                              ? current.filter((m) => m !== model)
                              : [...new Set([...current, model])]
                          )
                        }
                      />
                      Reasoning
                    </label>
                  ) : null}
                  {selected.includes(model) && speaksResponses ? (
                    <label
                      className="flex shrink-0 items-center gap-1 text-xs text-foreground-muted"
                      title="Codex sends a web search tool with every request. Many gateways reject it; turn it on only for models whose provider supports it."
                    >
                      <Checkbox
                        checked={webSearch.includes(model)}
                        onCheckedChange={(checked) =>
                          setWebSearch((current) =>
                            checked === true
                              ? [...new Set([...current, model])]
                              : current.filter((m) => m !== model)
                          )
                        }
                      />
                      Web search (Codex)
                    </label>
                  ) : null}
                  {selected.includes(model) && speaksResponses ? (
                    <ModelEffortsButton
                      model={model}
                      reasoning={!nonReasoning.includes(model)}
                      own={codexReasoningByModel[model]}
                      inherited={providerEfforts}
                      onChange={(next) =>
                        setCodexReasoningByModel((current) => {
                          const { [model]: _dropped, ...rest } = current;
                          return next ? { ...rest, [model]: next } : rest;
                        })
                      }
                    />
                  ) : null}
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
          <Field.Description>
            Fetch the upstream models, or type model ids below. Publish agent-facing aliases in
            Gateway models; these suggestions do not change published routes.
          </Field.Description>
        )}
        {selected.length > 0 ? (
          <Field.Description>
            Context: the model's context window, e.g. 1m or 256k. Codex, OpenCode, Pi, Oh My Pi and
            Claude Code use it. Leave it blank to keep the default. Reasoning: Pi, Oh My Pi and
            Codex offer reasoning efforts for the model; turn it off for models that reject them.
          </Field.Description>
        ) : null}
        {speaksResponses ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">Codex reasoning efforts</span>
            <CodexEffortPicker
              value={providerEfforts}
              onChange={(next) =>
                setCodexReasoning(sameEfforts(next, DEFAULT_CODEX_REASONING) ? undefined : next)
              }
            />
            <Field.Description>
              Codex offers these efforts on this provider&apos;s models. Pick the ones the provider
              accepts: it may reject the others with an error.
            </Field.Description>
          </div>
        ) : null}
        {speaksResponses ? (
          <Field.Description>
            In one Codex conversation, stay with models from the same vendor. Some models return
            encrypted reasoning that models from other vendors cannot read, and the conversation
            then fails with &quot;encrypted history requires an owned session&quot;. Start a new
            conversation to switch.
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
          disabled={
            busy ||
            (Boolean(initial) && !storedKeys.data) ||
            !name.trim() ||
            !hasBaseUrl ||
            invalidContext
          }
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * More sign-ins of Claude Code's or Codex's own vendor account, each with a config dir
 * of its own (its login), sharing sessions, settings and skills with the main one.
 */
function OfficialAccounts({
  providers,
  saveProviders,
}: {
  providers: ModelProvider[];
  saveProviders: (next: ModelProvider[]) => void;
}) {
  const accounts = providers.filter((provider) => provider.account);
  const [adding, setAdding] = useState(false);
  const [agent, setAgent] = useState<OfficialAccountAgent>('claude');
  const [name, setName] = useState('');

  const add = () => {
    if (!name.trim()) return;
    saveProviders([
      ...providers,
      {
        id: crypto.randomUUID().slice(0, 8),
        name: name.trim(),
        baseUrl: '',
        models: [],
        account: { agent },
      },
    ]);
    setName('');
    setAdding(false);
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Official accounts</h3>
        <p className="text-xs text-foreground-muted">
          More Claude or ChatGPT accounts to run Claude Code or Codex on, picked like a provider.
          Each keeps its own sign-in; sessions, settings, skills and MCP servers stay shared, so a
          conversation can resume on another account. Your usual login stays the default.
        </p>
      </div>
      {accounts.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li key={account.id}>
              <OfficialAccountRow
                account={account}
                onRename={(next) =>
                  saveProviders(
                    providers.map((p) => (p.id === account.id ? { ...p, name: next } : p))
                  )
                }
                onDelete={async () => {
                  const confirmed = await openModal('confirmActionModal', {
                    title: `Remove ${account.name}?`,
                    description:
                      'Emdash stops offering it; conversations set to it will not start until you pick another source. Its sign-in stays on this computer (in ~/.emdash/accounts); sign out there with the agent’s own logout if you want it gone.',
                    confirmLabel: 'Remove',
                  });
                  if (!confirmed.success) return;
                  saveProviders(providers.filter((p) => p.id !== account.id));
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className="flex items-end gap-2 rounded-md border border-border p-3">
          <div className="w-40 shrink-0">
            <Field.Root>
              <Field.Label>Agent</Field.Label>
              <Select.Root
                value={agent}
                onValueChange={(next) => next && setAgent(next as OfficialAccountAgent)}
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value>{AGENT_NAMES[agent]}</Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  {OFFICIAL_ACCOUNT_AGENTS.map((candidate) => (
                    <Select.Item key={candidate} value={candidate}>
                      {AGENT_NAMES[candidate]}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field.Root>
          </div>
          <div className="min-w-0 flex-1">
            <Field.Root>
              <Field.Label>Name</Field.Label>
              <Input
                value={name}
                placeholder="Work account"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add();
                }}
              />
            </Field.Root>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!name.trim()} onClick={add}>
            Add
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add account
        </Button>
      )}
    </section>
  );
}

function OfficialAccountRow({
  account,
  onRename,
  onDelete,
}: {
  account: ModelProvider;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const {
    data: status,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['officialAccountStatus', account.id],
    queryFn: async () =>
      (await getAgentsClient()).officialAccountStatus({ providerId: account.id }),
  });
  const agent = account.account!.agent;

  const signIn = async () => {
    const result = await (
      await getAgentsClient()
    ).openOfficialAccountLogin({ providerId: account.id });
    if (result.opened) {
      toast.success('Finish signing in in the Terminal window, then press Refresh.');
    } else {
      await navigator.clipboard.writeText(result.command).catch(() => undefined);
      toast.success(`Run this in a terminal (copied): ${result.command}`);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        {renaming !== null ? (
          <Input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              if (renaming.trim()) onRename(renaming.trim());
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <p className="text-sm text-foreground">{account.name}</p>
        )}
        <p className="truncate text-xs text-foreground-muted">
          {AGENT_NAMES[agent]} · {OFFICIAL_ACCOUNT_LABELS[agent]} ·{' '}
          {!status ? (
            'checking…'
          ) : status.signedIn ? (
            <span translate="no">
              {status.email ?? 'signed in'}
              {status.plan ? ` (${status.plan})` : ''}
            </span>
          ) : (
            'not signed in'
          )}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => void signIn()}>
        {status?.signedIn ? 'Sign in again' : 'Sign in'}
      </Button>
      <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
        Refresh
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setRenaming(account.name)}>
        Rename
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void onDelete()}>
        Remove
      </Button>
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
function sameEfforts(a: CodexReasoning, b: CodexReasoning): boolean {
  return a.default === b.default && a.levels.join() === b.levels.join();
}

/**
 * Ticks the efforts Codex offers and picks the one it starts with. At least one stays
 * ticked, and unticking the default moves it to the nearest lower level left.
 */
function CodexEffortPicker({
  value,
  onChange,
}: {
  value: CodexReasoning;
  /** Absent: shown read-only. */
  onChange?: (next: CodexReasoning) => void;
}) {
  const readOnly = !onChange;
  const toggle = (effort: CodexReasoningEffort, on: boolean) => {
    if (!onChange) return;
    if (on) {
      onChange({ ...value, levels: normalizeCodexReasoningLevels([...value.levels, effort]) });
      return;
    }
    if (value.levels.length <= 1) return;
    const levels = normalizeCodexReasoningLevels(value.levels.filter((e) => e !== effort));
    const next = defaultAfterRemoving(value.levels, value.default, effort);
    if (next) onChange({ levels, default: next });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {CODEX_REASONING_EFFORTS.map((effort) => {
        const on = value.levels.includes(effort);
        return (
          <label
            key={effort}
            className="flex items-center gap-1 font-mono text-xs text-foreground-muted"
            translate="no"
          >
            <Checkbox
              checked={on}
              disabled={readOnly || (on && value.levels.length === 1)}
              onCheckedChange={(checked) => toggle(effort, checked === true)}
            />
            {effort}
          </label>
        );
      })}
      <div className="flex items-center gap-1 text-xs text-foreground-muted">
        Default
        <Select.Root
          value={value.default}
          disabled={readOnly}
          onValueChange={(next) => {
            const effort = value.levels.find((level) => level === next);
            if (effort) onChange?.({ ...value, default: effort });
          }}
        >
          <Select.Trigger className="h-7 gap-1 font-mono text-xs">
            <Select.Value>{value.default}</Select.Value>
          </Select.Trigger>
          <Select.Content align="end">
            {value.levels.map((effort) => (
              <Select.Item key={effort} value={effort}>
                <span translate="no">{effort}</span>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  );
}

/** A model's own Codex efforts, or its provider's when it follows them (`own` unset). */
function ModelEffortsButton({
  model,
  reasoning,
  own,
  inherited,
  onChange,
}: {
  model: string;
  reasoning: boolean;
  own: CodexReasoning | undefined;
  inherited: CodexReasoning;
  onChange: (next: CodexReasoning | undefined) => void;
}) {
  const summary = own
    ? own.levels.length > 1
      ? `${own.levels[0]}–${own.levels.at(-1)}`
      : own.levels[0]
    : undefined;
  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={!reasoning}
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            title={reasoning ? undefined : 'Reasoning is off for this model'}
            aria-label={`Codex efforts of ${model}`}
          />
        }
      >
        {summary ? <span translate="no">{summary}</span> : 'Efforts'}
      </Popover.Trigger>
      <Popover.Content align="end" className="flex w-80 flex-col gap-3 p-3">
        <label className="flex items-center justify-between gap-2 text-xs text-foreground">
          Use the provider&apos;s efforts
          <Switch
            checked={!own}
            onCheckedChange={(follow) => onChange(follow ? undefined : inherited)}
          />
        </label>
        <CodexEffortPicker value={own ?? inherited} onChange={own ? onChange : undefined} />
      </Popover.Content>
    </Popover.Root>
  );
}

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
  const [roleTarget, setRoleTarget] = useState('');
  const soleModel = models.length === 1 ? models[0] : undefined;
  const target = soleModel ?? (models.includes(roleTarget) ? roleTarget : '');
  return (
    <Field.Root>
      <div className="flex items-center justify-between gap-2">
        <Field.Label>Claude Code models</Field.Label>
        <div className="flex min-w-0 items-center gap-2">
          {soleModel ? null : (
            <Select.Root
              value={target}
              onValueChange={(next) => setRoleTarget(next ? String(next) : '')}
            >
              <Select.Trigger appearance="input" className="h-7 w-40">
                <Select.Value>
                  {target ? (
                    <span className="truncate font-mono text-xs">{target}</span>
                  ) : (
                    <span className="text-foreground-passive">Model</span>
                  )}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                {models.map((model) => (
                  <Select.Item key={model} value={model}>
                    <span className="font-mono text-xs">{model}</span>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            disabled={!target}
            onClick={() => {
              if (!target) return;
              onChange(claudeRolesForEveryRole(value, target));
            }}
          >
            Use for every role
          </Button>
        </div>
      </div>
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
function AgentDefaults() {
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
          <AgentDefaultRow key={agentId} agentId={agentId} />
        ))}
      </div>
    </section>
  );
}

const AgentDefaultRow = observer(function AgentDefaultRow({ agentId }: { agentId: string }) {
  const { value: config, update, reset } = useAgentSettings(agentId, hostRefFromConnectionId());
  const save = (value: ModelSourceValue) => {
    const next = {
      ...config,
      modelSource: value.modelSource ?? undefined,
      sourceModel: value.sourceModel,
    };
    if (!next.extraArgs && !next.env && !next.modelSource) reset(undefined);
    else update(next);
  };
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 px-3 py-3">
      <span className="pt-2 text-sm">{AGENT_NAMES[agentId]}</span>
      <div className="space-y-2">
        <ModelSourceSelect
          agentId={agentId}
          value={{ modelSource: config?.modelSource ?? null, sourceModel: config?.sourceModel }}
          onChange={save}
          showReset={false}
        />
      </div>
    </div>
  );
});
