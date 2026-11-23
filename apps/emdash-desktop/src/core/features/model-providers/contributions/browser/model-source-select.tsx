import { ComboboxPopover } from '@emdash/ui/react/components';
import { Button, Field, Select } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  activeSourceForAgent,
  catalogSourceId,
  gatewayBindingFromSource,
  modelAvailableForAgent,
  publishedModelAliases,
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
        <Field.Label>连接方式</Field.Label>
        <Field.Description>此 Agent 使用自己的配置，当前还不能接入统一网关。</Field.Description>
      </Field.Root>
    );
  const source = effective?.modelSource ?? null;
  const model = effective?.sourceModel;
  const official = remote
    ? []
    : (settings?.providers ?? []).filter((p) => p.account?.agent === agentId);
  const legacy = source && source !== catalogSourceId && !official.some((p) => p.id === source);
  const providers = settings?.providers ?? [];
  const models = (catalog?.models ?? []).filter((m) =>
    modelAvailableForAgent(m, providers, agentId)
  );
  const selectedModel = models.find((candidate) =>
    model ? publishedModelAliases(candidate).includes(model) : false
  );
  const selectedSource = selectedModel && activeSourceForAgent(selectedModel, agentId);
  const selectedBinding =
    selectedModel && selectedSource
      ? gatewayBindingFromSource(selectedModel, selectedSource, model)
      : undefined;
  const selected = source === catalogSourceId ? catalogSourceId : legacy ? source : OWN_LOGIN;
  const label =
    source === catalogSourceId
      ? '统一网关'
      : legacy
        ? '已保存的旧连接配置'
        : defaultSourceLabel(agentId);
  return (
    <>
      <Field.Root>
        <Field.Label>连接方式</Field.Label>
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
                        model &&
                        models.some((candidate) => publishedModelAliases(candidate).includes(model))
                          ? model
                          : undefined,
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
              统一网关{remote ? '（仅支持本机 Agent）' : ''}
            </Select.Item>
            {legacy && source ? <Select.Item value={source}>已保存的旧连接配置</Select.Item> : null}
          </Select.Content>
        </Select.Root>
        {value.modelSource === undefined ? (
          <Field.Description>跟随 Agent 默认设置。</Field.Description>
        ) : null}
        {showReset ? (
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            恢复 Agent 默认设置
          </Button>
        ) : null}
      </Field.Root>
      {source !== catalogSourceId && !legacy && official.length > 0 ? (
        <Field.Root>
          <Field.Label>官方账号</Field.Label>
          <Select.Root
            value={source ?? ''}
            onValueChange={(next) => onChange({ modelSource: next ? String(next) : null })}
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value>
                {official.find((p) => p.id === source)?.name ?? '默认登录'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content width="trigger">
              <Select.Item value="">默认登录</Select.Item>
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
          <Field.Label>网关模型</Field.Label>
          <ComboboxPopover
            items={models}
            value={model}
            itemToKey={(candidate) => candidate.primaryAlias}
            itemToLabel={(candidate) => candidate.displayName}
            filter={(m, query) =>
              `${m.displayName} ${m.primaryAlias} ${m.legacyAliases.join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase())
            }
            onValueChange={(alias) =>
              onChange({ modelSource: catalogSourceId, sourceModel: alias })
            }
            renderTrigger={(m) =>
              m
                ? `${m.displayName} · ${model ?? m.primaryAlias}`
                : model
                  ? `${model}（不可用）`
                  : '选择模型'
            }
            renderItem={(m) => (
              <span>
                {m.displayName}
                <span className="ml-2 text-xs text-foreground-muted">{m.primaryAlias}</span>
              </span>
            )}
            searchPlaceholder="搜索网关模型…"
            appearance="input"
            className="w-full"
            disabled={remote}
          />
          <Field.Description>
            {models.length
              ? '协议和来源在“设置 → 模型与路由 → 模型”中统一管理。'
              : '请先在“设置 → 模型与路由 → 模型”中发布兼容模型。'}
          </Field.Description>
          {agentId === 'codex' ? (
            <Field.Description>
              Codex 网关模型必须配置原生 OpenAI Responses 路由。
            </Field.Description>
          ) : null}
          {agentId === 'claude' &&
          selectedBinding &&
          upstreamProtocol(selectedBinding, 'anthropic') !== 'anthropic' ? (
            <Field.Description>
              当前来源需要协议转换，本次会话会关闭 Claude 提示缓存和实验性工具能力。
            </Field.Description>
          ) : null}
        </Field.Root>
      ) : null}
    </>
  );
});
