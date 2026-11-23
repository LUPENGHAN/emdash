import { Button, Checkbox, Dialog, Field, Input, Select } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  PROVIDER_PROTOCOL_LABELS,
  PROVIDER_PROTOCOLS,
  type ModelProvider,
} from '@core/features/model-providers/api';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import { getModelGatewayClient } from '../../api/browser/client';
import {
  activeSourceForAgent,
  agentUpstreamProtocol,
  configuredProtocols,
  gatewayBindingFromSource,
  gatewayModelsSettingsSchema,
  publishedModelAliases,
  type GatewayModelSource,
  type GatewayModelsSettings,
  type PublishedGatewayModel,
} from '../../api/model-catalog';

type Draft = Pick<GatewayModelsSettings, 'models' | 'ignoredSourceIds'>;

const STATE_LABELS: Record<PublishedGatewayModel['state'], string> = {
  active: '启用',
  hidden: '隐藏',
  disabled: '停用',
  archived: '已归档',
};

function sourceFingerprint(source: GatewayModelSource): string {
  return `${source.providerId}:${JSON.stringify(source.protocolModels)}`;
}

function makeSource(provider: ModelProvider, upstreamModel: string): GatewayModelSource {
  const id = `source:${crypto.randomUUID()}`;
  return {
    id,
    providerId: provider.id,
    enabled: true,
    protocolModels: Object.fromEntries(
      configuredProtocols(provider).map((protocol) => [protocol, { upstreamModel }])
    ),
    protocolPolicy: { mode: 'auto' },
  };
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function duplicateGroups(models: PublishedGatewayModel[]): PublishedGatewayModel[][] {
  const groups = new Map<string, PublishedGatewayModel[]>();
  for (const model of models) {
    const upstream = model.sources.flatMap((source) =>
      Object.values(source.protocolModels).map((binding) => normalizeName(binding.upstreamModel))
    );
    const keys = new Set([normalizeName(model.displayName), ...upstream].filter(Boolean));
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  const seen = new Set<string>();
  return [...groups.values()].filter((group) => {
    const ids = [...new Set(group.map((model) => model.id))].sort();
    const key = ids.join(':');
    if (ids.length < 2 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One logical model can bind multiple supplier sources without changing saved route snapshots. */
export function GatewayModelsPanel() {
  const settings = useAppSettingsKey('gatewayModels');
  const inventory = useAppSettingsKey('modelProviders');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<string>();
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [discovered, setDiscovered] = useState<PublishedGatewayModel[]>([]);

  const providers = (inventory.value?.providers ?? []).filter((provider) => !provider.account);
  const saved: Draft = {
    models: settings.value?.models ?? [],
    ignoredSourceIds: settings.value?.ignoredSourceIds ?? [],
  };
  const value = draft ?? saved;
  const editing = value.models.find((model) => model.id === selected);
  const visibleModels = value.models.filter((model) =>
    `${model.displayName} ${publishedModelAliases(model).join(' ')} ${model.sources
      .map((source) => providers.find((provider) => provider.id === source.providerId)?.name ?? '')
      .join(' ')}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase())
  );
  const groups = useMemo(() => duplicateGroups(value.models), [value.models]);

  const change = (next: Draft) => {
    setDraft(next);
    setTestResult(undefined);
  };
  const patchModel = (patch: Partial<PublishedGatewayModel>) => {
    if (!editing) return;
    change({
      ...value,
      models: value.models.map((model) =>
        model.id === editing.id ? { ...model, ...patch } : model
      ),
    });
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const save = async (next = value) => {
    const parsed = gatewayModelsSettingsSchema.parse({
      version: 2,
      models: next.models,
      ignoredSourceIds: next.ignoredSourceIds,
      legacyModels: settings.value?.legacyModels,
      migration: settings.value?.migration,
    });
    await (
      await getModelGatewayClient()
    ).saveModels({ models: parsed.models, ignoredSourceIds: parsed.ignoredSourceIds });
    await queryClient.invalidateQueries({ queryKey: ['appSettings', 'gatewayModels'] });
    await queryClient.invalidateQueries({ queryKey: ['modelGateway'] });
    setDraft(undefined);
  };

  const discover = () =>
    void run(async () => {
      const preview = await (await getModelGatewayClient()).migrationPreview();
      const existing = new Set(
        value.models.flatMap((model) => model.sources.map(sourceFingerprint))
      );
      setDiscovered(
        preview.filter((candidate) => {
          const source = candidate.sources[0];
          return (
            source &&
            !existing.has(sourceFingerprint(source)) &&
            !value.ignoredSourceIds.includes(sourceFingerprint(source))
          );
        })
      );
      setDiscoveryOpen(true);
    });

  const importCandidate = (candidate: PublishedGatewayModel, target?: PublishedGatewayModel) => {
    const source = candidate.sources[0];
    if (!source) return;
    if (!target) {
      change({ ...value, models: [...value.models, candidate] });
      setSelected(candidate.id);
    } else {
      const activeSourceByProtocol = { ...target.activeSourceByProtocol };
      for (const protocol of PROVIDER_PROTOCOLS) activeSourceByProtocol[protocol] ??= source.id;
      change({
        ...value,
        models: value.models.map((model) =>
          model.id === target.id
            ? {
                ...model,
                sources: [...model.sources, source],
                activeSourceByProtocol,
              }
            : model
        ),
      });
    }
    const remaining = discovered.filter((model) => model.id !== candidate.id);
    setDiscovered(remaining);
    if (remaining.length === 0) setDiscoveryOpen(false);
  };

  const mergeGroup = (group: PublishedGatewayModel[]) => {
    const [canonical, ...merged] = group;
    if (!canonical) return;
    const sources = [canonical, ...merged].flatMap((model) => model.sources);
    const uniqueSources = [
      ...new Map(sources.map((source) => [sourceFingerprint(source), source])).values(),
    ];
    const combined: PublishedGatewayModel = {
      ...canonical,
      legacyAliases: [
        ...new Set(
          [canonical, ...merged]
            .flatMap((model) => publishedModelAliases(model))
            .filter((candidate) => candidate !== canonical.primaryAlias)
        ),
      ],
      sources: uniqueSources,
      activeSourceByProtocol: Object.assign(
        {},
        ...[...merged, canonical].map((model) => model.activeSourceByProtocol)
      ),
    };
    const mergedIds = new Set(merged.map((model) => model.id));
    change({
      ...value,
      models: value.models
        .filter((model) => !mergedIds.has(model.id))
        .map((model) => (model.id === canonical.id ? combined : model)),
    });
    setSelected(canonical.id);
    if (groups.length <= 1) setOrganizeOpen(false);
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">模型目录</h2>
          <p className="text-xs text-foreground-muted">
            一个模型可以连接多个来源；每种 Agent 协议只使用你明确指定的当前来源，不会静默切换。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={discover}>
            发现来源
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || groups.length === 0}
            onClick={() => setOrganizeOpen(true)}
          >
            整理重复模型{groups.length ? `（${groups.length}）` : ''}
          </Button>
          <Button
            size="sm"
            disabled={busy || providers.length === 0}
            onClick={() => {
              const provider = providers[0];
              if (!provider) return;
              const id = crypto.randomUUID();
              const source = makeSource(provider, 'model-id');
              change({
                ...value,
                models: [
                  ...value.models,
                  {
                    id,
                    primaryAlias: `model-${id.slice(0, 8)}`,
                    legacyAliases: [],
                    displayName: '新模型',
                    state: 'active',
                    revision: 1,
                    sources: [source],
                    activeSourceByProtocol: Object.fromEntries(
                      PROVIDER_PROTOCOLS.map((protocol) => [protocol, source.id])
                    ),
                  },
                ],
              });
              setSelected(id);
            }}
          >
            添加模型
          </Button>
        </div>
      </div>

      <div className="@container grid min-h-[32rem] gap-4 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(24rem,1.4fr)]">
        <div className="space-y-2 rounded-md border border-border p-3">
          <Field.Root>
            <Field.Label>搜索模型</Field.Label>
            <Input
              type="search"
              value={filter}
              placeholder="名称、别名或来源"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
            />
          </Field.Root>
          <ul className="max-h-[40rem] space-y-1 overflow-y-auto" aria-label="模型目录">
            {visibleModels.map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  aria-current={model.id === selected ? 'true' : undefined}
                  className={`w-full rounded-md border px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    model.id === selected
                      ? 'border-accent bg-background-2'
                      : 'border-transparent hover:bg-background-1'
                  }`}
                  onClick={() => {
                    setSelected(model.id);
                    setError(undefined);
                    setTestResult(undefined);
                  }}
                >
                  <span className="block truncate text-sm">{model.displayName}</span>
                  <span className="block truncate text-xs text-foreground-muted">
                    {model.primaryAlias} · {model.sources.length} 个来源 ·{' '}
                    {STATE_LABELS[model.state]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {visibleModels.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-foreground-muted">
              {value.models.length ? '没有匹配的模型。' : '还没有模型，请添加或发现来源。'}
            </p>
          ) : null}
        </div>

        <div className="min-w-0 rounded-md border border-border p-4">
          {editing ? (
            <ModelEditor
              model={editing}
              providers={providers}
              saved={Boolean(settings.value?.models.some((model) => model.id === editing.id))}
              busy={busy}
              testResult={testResult}
              onPatch={patchModel}
              onTest={(agent) =>
                void run(async () => {
                  const result = await (
                    await getModelGatewayClient()
                  ).testModel({ alias: editing.primaryAlias, agent });
                  setTestResult(
                    `${agent === 'claude' ? 'Claude' : 'Codex'}：HTTP ${result.status}，${
                      result.ok ? '协议响应有效。' : '请求失败或响应格式无效。'
                    }`
                  );
                })
              }
              onDeleteSource={(sourceId) => {
                if (editing.sources.length === 1) return;
                const activeSourceByProtocol = Object.fromEntries(
                  Object.entries(editing.activeSourceByProtocol).filter(([, id]) => id !== sourceId)
                );
                patchModel({
                  sources: editing.sources.filter((source) => source.id !== sourceId),
                  activeSourceByProtocol,
                });
              }}
              onAddSource={() => {
                const provider =
                  providers.find(
                    (candidate) =>
                      !editing.sources.some((source) => source.providerId === candidate.id)
                  ) ?? providers[0];
                if (!provider) return;
                patchModel({
                  sources: [...editing.sources, makeSource(provider, editing.primaryAlias)],
                });
              }}
              onArchive={() => patchModel({ state: 'archived' })}
              onPermanentDelete={() =>
                void run(async () => {
                  const confirmed = await openModal('confirmActionModal', {
                    title: `永久删除“${editing.displayName}”？`,
                    description:
                      '当前模型会从目录移除；历史会话快照和用量记录仍保留。如果还有会话引用，系统会拒绝删除并提示先归档。',
                    confirmLabel: '永久删除',
                  });
                  if (!confirmed.success) return;
                  const next = {
                    ...value,
                    models: value.models.filter((model) => model.id !== editing.id),
                  };
                  await save(next);
                  setSelected(undefined);
                })
              }
            />
          ) : (
            <div className="grid h-full min-h-72 place-items-center text-sm text-foreground-muted">
              从左侧选择一个模型进行管理。
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !draft} onClick={() => void run(() => save())}>
          {busy ? '保存中…' : '保存模型目录'}
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
            放弃更改
          </Button>
        ) : null}
        <p className="text-xs text-foreground-muted">
          已有会话继续使用保存时的路由快照；来源变化只影响新会话或明确重启后的会话。
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}

      <DiscoveryDialog
        open={discoveryOpen}
        onOpenChange={setDiscoveryOpen}
        candidates={discovered}
        providers={providers}
        target={editing}
        onImport={importCandidate}
        onIgnore={(candidate) => {
          const source = candidate.sources[0];
          if (!source) return;
          const fingerprint = sourceFingerprint(source);
          change({
            ...value,
            ignoredSourceIds: [...new Set([...value.ignoredSourceIds, fingerprint])],
          });
          const remaining = discovered.filter((model) => model.id !== candidate.id);
          setDiscovered(remaining);
          if (remaining.length === 0) setDiscoveryOpen(false);
        }}
      />
      <OrganizeDialog
        open={organizeOpen}
        onOpenChange={setOrganizeOpen}
        groups={groups}
        onMerge={mergeGroup}
      />
    </section>
  );
}

function ModelEditor({
  model,
  providers,
  saved,
  busy,
  testResult,
  onPatch,
  onTest,
  onDeleteSource,
  onAddSource,
  onArchive,
  onPermanentDelete,
}: {
  model: PublishedGatewayModel;
  providers: ModelProvider[];
  saved: boolean;
  busy: boolean;
  testResult?: string;
  onPatch: (patch: Partial<PublishedGatewayModel>) => void;
  onTest: (agent: 'claude' | 'codex') => void;
  onDeleteSource: (sourceId: string) => void;
  onAddSource: () => void;
  onArchive: () => void;
  onPermanentDelete: () => void;
}) {
  const patchSource = (sourceId: string, patch: Partial<GatewayModelSource>) =>
    onPatch({
      sources: model.sources.map((source) =>
        source.id === sourceId ? { ...source, ...patch } : source
      ),
    });
  const routeFor = (agent: 'claude' | 'codex') => {
    const source = activeSourceForAgent(model, agent);
    return source ? gatewayBindingFromSource(model, source) : undefined;
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2">
        <Field.Root>
          <Field.Label>显示名称</Field.Label>
          <Input
            value={model.displayName}
            onChange={(event) => onPatch({ displayName: event.target.value })}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>公开别名</Field.Label>
          <Input
            value={model.primaryAlias}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => onPatch({ primaryAlias: event.target.value })}
          />
          <Field.Description>
            改名后旧别名会自动保留。
            {model.legacyAliases.length ? ` 兼容：${model.legacyAliases.join('、')}` : ''}
          </Field.Description>
        </Field.Root>
        <Field.Root>
          <Field.Label>目录状态</Field.Label>
          <Select.Root
            value={model.state}
            onValueChange={(value) => onPatch({ state: value as PublishedGatewayModel['state'] })}
          >
            <Select.Trigger appearance="input">
              <Select.Value>{STATE_LABELS[model.state]}</Select.Value>
            </Select.Trigger>
            <Select.Content width="trigger">
              {Object.entries(STATE_LABELS).map(([value, label]) => (
                <Select.Item key={value} value={value}>
                  {label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field.Root>
        <Field.Root>
          <Field.Label>上下文窗口（tokens）</Field.Label>
          <Input
            type="number"
            min={1}
            value={model.contextWindow ?? ''}
            placeholder="未知"
            onChange={(event) =>
              onPatch({
                contextWindow: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          />
        </Field.Root>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">来源</legend>
        <p className="text-xs text-foreground-muted">
          同一模型可绑定多个服务源；删除来源不会删除服务源本身。
        </p>
        {model.sources.map((source, index) => (
          <SourceEditor
            key={source.id}
            source={source}
            index={index}
            providers={providers}
            canDelete={model.sources.length > 1}
            onPatch={(patch) => patchSource(source.id, patch)}
            onDelete={() => onDeleteSource(source.id)}
          />
        ))}
        <Button size="sm" variant="secondary" disabled={!providers.length} onClick={onAddSource}>
          添加来源
        </Button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">当前来源</legend>
        <p className="text-xs text-foreground-muted">
          每种入站协议都必须明确选择来源；来源不可用时直接报错，不自动故障转移。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {PROVIDER_PROTOCOLS.map((protocol) => {
            const sourceId = model.activeSourceByProtocol[protocol] ?? '';
            return (
              <Field.Root key={protocol}>
                <Field.Label>{PROVIDER_PROTOCOL_LABELS[protocol]}</Field.Label>
                <Select.Root
                  value={sourceId}
                  onValueChange={(value) =>
                    onPatch({
                      activeSourceByProtocol: {
                        ...model.activeSourceByProtocol,
                        [protocol]: String(value),
                      },
                    })
                  }
                >
                  <Select.Trigger appearance="input">
                    <Select.Value>
                      {sourceLabel(
                        model.sources.find((source) => source.id === sourceId),
                        providers
                      ) ?? '选择来源'}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Content width="trigger">
                    {model.sources
                      .filter((source) => source.enabled)
                      .map((source) => (
                        <Select.Item key={source.id} value={source.id}>
                          {sourceLabel(source, providers)}
                        </Select.Item>
                      ))}
                  </Select.Content>
                </Select.Root>
              </Field.Root>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-wrap gap-4 text-xs">
        <legend className="mb-2 w-full text-sm font-medium">模型能力</legend>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={model.nonReasoning === true}
            onCheckedChange={(value) => onPatch({ nonReasoning: value === true })}
          />
          关闭推理强度控件
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={model.webSearch === true}
            onCheckedChange={(value) => onPatch({ webSearch: value === true })}
          />
          支持 Codex 原生网页搜索
        </label>
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {(['claude', 'codex'] as const).map((agent) => {
            const route = routeFor(agent);
            return (
              <Button
                key={agent}
                size="sm"
                variant="secondary"
                disabled={
                  busy ||
                  !saved ||
                  model.state !== 'active' ||
                  !route ||
                  !agentUpstreamProtocol(route, agent)
                }
                onClick={() => onTest(agent)}
              >
                测试 {agent === 'claude' ? 'Claude' : 'Codex'} 路由
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-foreground-muted">
          测试会发送一个很小的真实请求并消耗服务源额度；未保存的路由不能测试。
        </p>
        {testResult ? (
          <p role="status" className="text-xs">
            {testResult}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button
          size="sm"
          variant="secondary"
          disabled={model.state === 'archived'}
          onClick={onArchive}
        >
          归档模型
        </Button>
        <Button size="sm" variant="destructive" onClick={onPermanentDelete}>
          永久删除
        </Button>
      </div>
    </div>
  );
}

function SourceEditor({
  source,
  index,
  providers,
  canDelete,
  onPatch,
  onDelete,
}: {
  source: GatewayModelSource;
  index: number;
  providers: ModelProvider[];
  canDelete: boolean;
  onPatch: (patch: Partial<GatewayModelSource>) => void;
  onDelete: () => void;
}) {
  const provider = providers.find((candidate) => candidate.id === source.providerId);
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">来源 {index + 1}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={source.enabled}
              onCheckedChange={(value) => onPatch({ enabled: value === true })}
            />
            启用
          </label>
          <Button size="xs" variant="ghost" disabled={!canDelete} onClick={onDelete}>
            移除
          </Button>
        </div>
      </div>
      <Field.Root>
        <Field.Label>服务源</Field.Label>
        <Select.Root
          value={source.providerId}
          onValueChange={(value) => {
            const next = providers.find((candidate) => candidate.id === value);
            if (!next) return;
            const upstreamModel =
              Object.values(source.protocolModels)[0]?.upstreamModel ?? 'model-id';
            onPatch({
              providerId: next.id,
              protocolModels: makeSource(next, upstreamModel).protocolModels,
            });
          }}
        >
          <Select.Trigger appearance="input">
            <Select.Value>{provider?.name ?? '服务源已丢失'}</Select.Value>
          </Select.Trigger>
          <Select.Content width="trigger">
            {providers.map((candidate) => (
              <Select.Item key={candidate.id} value={candidate.id}>
                {candidate.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Field.Root>
      <div className="space-y-2">
        {(provider ? configuredProtocols(provider) : PROVIDER_PROTOCOLS).map((protocol) => {
          const binding = source.protocolModels[protocol];
          return (
            <div
              key={protocol}
              className="grid items-center gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]"
            >
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={Boolean(binding)}
                  onCheckedChange={(checked) => {
                    const protocolModels = { ...source.protocolModels };
                    if (checked)
                      protocolModels[protocol] = {
                        upstreamModel:
                          Object.values(protocolModels)[0]?.upstreamModel ?? 'model-id',
                      };
                    else delete protocolModels[protocol];
                    onPatch({ protocolModels });
                  }}
                />
                {PROVIDER_PROTOCOL_LABELS[protocol]}
              </label>
              {binding ? (
                <Input
                  aria-label={`${PROVIDER_PROTOCOL_LABELS[protocol]} 上游模型`}
                  value={binding.upstreamModel}
                  onChange={(event) =>
                    onPatch({
                      protocolModels: {
                        ...source.protocolModels,
                        [protocol]: { upstreamModel: event.target.value },
                      },
                    })
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sourceLabel(
  source: GatewayModelSource | undefined,
  providers: ModelProvider[]
): string | undefined {
  if (!source) return undefined;
  return providers.find((provider) => provider.id === source.providerId)?.name ?? source.providerId;
}

function DiscoveryDialog({
  open,
  onOpenChange,
  candidates,
  providers,
  target,
  onImport,
  onIgnore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: PublishedGatewayModel[];
  providers: ModelProvider[];
  target?: PublishedGatewayModel;
  onImport: (candidate: PublishedGatewayModel, target?: PublishedGatewayModel) => void;
  onIgnore: (candidate: PublishedGatewayModel) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="lg">
        <Dialog.Header>
          <Dialog.Title>发现来源</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body className="space-y-3">
          <Dialog.Description>
            这里只展示尚未纳入目录且未被忽略的来源。系统不会按相似名称自动合并。
          </Dialog.Description>
          {candidates.length ? (
            <ul className="space-y-2">
              {candidates.map((candidate) => {
                const source = candidate.sources[0];
                return (
                  <li
                    key={candidate.id}
                    className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{candidate.displayName}</p>
                      <p className="truncate text-xs text-foreground-muted">
                        {sourceLabel(source, providers)} ·{' '}
                        {Object.values(source?.protocolModels ?? {})
                          .map((binding) => binding.upstreamModel)
                          .join('、')}
                      </p>
                    </div>
                    {target ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onImport(candidate, target)}
                      >
                        添加到“{target.displayName}”
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => onImport(candidate)}>
                      作为新模型导入
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onIgnore(candidate)}>
                      忽略
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-foreground-muted">没有新的来源。</p>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="secondary" />}>完成</Dialog.Close>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function OrganizeDialog({
  open,
  onOpenChange,
  groups,
  onMerge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PublishedGatewayModel[][];
  onMerge: (group: PublishedGatewayModel[]) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="lg">
        <Dialog.Header>
          <Dialog.Title>整理重复模型</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body className="space-y-3">
          <Dialog.Description>
            以下只是基于完全一致的显示名或上游模型 ID 生成的建议。合并会保留第一个模型的内部
            ID，并把其它公开别名转为兼容别名；历史路由和用量记录不会改写。
          </Dialog.Description>
          {groups.map((group) => (
            <div
              key={group.map((model) => model.id).join(':')}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm">{group.map((model) => model.displayName).join(' / ')}</p>
                <p className="text-xs text-foreground-muted">
                  {group.length} 个目录项 ·{' '}
                  {group.reduce((total, model) => total + model.sources.length, 0)} 个来源
                </p>
              </div>
              <Button size="sm" onClick={() => onMerge(group)}>
                合并到“{group[0]?.displayName}”
              </Button>
            </div>
          ))}
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="secondary" />}>完成</Dialog.Close>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
