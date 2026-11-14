import {
  providerEndpoints,
  type ModelProvider,
  type ProviderProtocol,
} from '@core/features/model-providers/api';
import type { ApiProvider } from './config';

export type ProviderCredential = {
  provider: ModelProvider;
  apiKey: string | null;
  protocolKeys?: Partial<Record<ProviderProtocol, string | null>>;
};

/** Projects the Providers inventory into transient SDK configuration. */
export function gatewayProviders(inventory: ProviderCredential[]): ApiProvider[] {
  return inventory.flatMap(({ provider, apiKey, protocolKeys }) => {
    if (
      provider.account ||
      (!apiKey && !Object.values(protocolKeys ?? {}).some(Boolean)) ||
      !provider.models.length
    )
      return [];
    const endpoints = providerEndpoints(provider);
    const baseUrl = endpoints.openai?.url ?? `${endpoints.anthropic?.url}/v1`;
    for (const base of [
      baseUrl,
      ...(endpoints.anthropic ? [endpoints.anthropic.url] : []),
      ...(endpoints.openai?.responsesUrl ? [endpoints.openai.responsesUrl] : []),
    ]) {
      const url = new URL(base);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !['http:', 'https:'].includes(url.protocol)
      )
        throw new Error(`Invalid provider URL: ${provider.name}`);
    }
    return [
      {
        id: provider.id,
        name: provider.name,
        protocol: provider.endpoints ? 'all' : (provider.protocol ?? 'all'),
        ...(provider.endpoints && {
          endpoints: Object.fromEntries(
            Object.entries(provider.endpoints).map(([protocol]) => [
              protocol,
              protocol === 'anthropic'
                ? `${endpoints.anthropic!.url}/v1`
                : protocol === 'openai-responses'
                  ? (endpoints.openai!.responsesUrl ?? endpoints.openai!.url)
                  : endpoints.openai!.url,
            ])
          ),
        }),
        baseUrl: baseUrl.replace(/\/+$/, ''),
        ...(endpoints.anthropic && {
          anthropicBaseUrl: `${endpoints.anthropic.url}/v1`,
          anthropicAuth: endpoints.anthropic.auth,
        }),
        apiKey: apiKey ?? '',
        protocolKeys: Object.fromEntries(
          Object.entries(protocolKeys ?? {}).filter((entry): entry is [string, string] =>
            Boolean(entry[1])
          )
        ),
        models: provider.models,
        modelMap: Object.fromEntries(
          provider.models.map((model) => [model, provider.modelAliases?.[model] ?? model])
        ),
        contextWindows: provider.contextWindows ?? {},
        headers: {},
      },
    ];
  });
}
