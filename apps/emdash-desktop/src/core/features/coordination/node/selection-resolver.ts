import { getPlugin } from '@core/features/agents/api/node/plugin-registry';
import { catalogProvider, type GatewayModel } from '@core/features/model-gateway/api/model-catalog';
import type { ModelProvider } from '@core/features/model-providers/api';
import { modelEffortOptions } from '@core/features/model-providers/api/model-effort';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import type { AgentSelection, ResolvedAgentSelection } from '../api/types';

type Dependencies = {
  defaultAgent(): Promise<string>;
  getAgentSettings(agent: string): Promise<ProviderCustomConfig | undefined>;
  getProviders(): Promise<ModelProvider[]>;
  getModels(): Promise<GatewayModel[]>;
};

/** Resolves a reusable selection without allocating a route or starting an agent. */
export function createSelectionResolver(deps: Dependencies) {
  return async (selection: AgentSelection): Promise<ResolvedAgentSelection> => {
    const agent = selection.agent ?? (await deps.defaultAgent());
    const plugin = getPlugin(agent);
    const [saved, providers, models] = await Promise.all([
      deps.getAgentSettings(agent),
      deps.getProviders(),
      deps.getModels(),
    ]);
    const sources: ResolvedAgentSelection['sources'] = {
      agent: selection.agent ? 'selection' : 'agent-default',
    };
    const savedProvider = providers.find((provider) => provider.id === saved?.modelSource);
    const savedConnection =
      saved?.modelSource === 'gateway:models' || (savedProvider && !savedProvider.account)
        ? 'gateway'
        : 'official';
    const connection = selection.connection ?? (selection.supplierId ? 'gateway' : savedConnection);
    sources.connection =
      selection.connection || selection.supplierId ? 'selection' : 'agent-default';
    const provider =
      connection === 'gateway'
        ? selection.supplierId
          ? providers.find((provider) => provider.id === selection.supplierId)
          : catalogProvider(models, agent)
        : undefined;
    const model =
      selection.model ??
      (selection.supplierId
        ? undefined
        : connection === savedConnection
          ? saved?.sourceModel
          : undefined);
    sources.model = selection.model ? 'selection' : model ? 'agent-default' : 'adapter-default';
    const effort = selection.effort !== undefined ? selection.effort : saved?.effort;
    sources.effort =
      selection.effort !== undefined
        ? 'selection'
        : saved?.effort
          ? 'agent-default'
          : 'adapter-default';
    const options = modelEffortOptions(plugin.capabilities.effort, agent, provider, model);
    const errors: string[] = [];
    if (selection.supplierId && selection.connection === 'official')
      errors.push('A supplier requires gateway access.');
    if (selection.supplierId && (!provider || provider.account))
      errors.push('The selected API supplier is unavailable.');
    if (selection.supplierId && !selection.model)
      errors.push('Specify a model for the selected supplier.');
    if (connection === 'gateway' && !model)
      errors.push('Select a gateway model for delegated tasks.');
    if (
      connection === 'gateway' &&
      !selection.supplierId &&
      model &&
      !provider?.models.includes(model)
    )
      errors.push('The selected gateway model is unavailable for this agent.');
    if (effort && !Object.hasOwn(options, effort))
      errors.push(
        `The selected agent/model does not support effort ${effort}. Choose a supported value or follow the model default.`
      );
    return {
      values: { agent, connection, supplierId: selection.supplierId, model, effort },
      sources,
      effortOptions: options,
      errors,
    };
  };
}
