import { secret } from '@emdash/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  PROVIDER_PROTOCOLS,
  modelProviderSecretKey,
  type ProviderProtocol,
  type ModelProviderKeys,
} from '../api';

/**
 * Provider API keys, kept in the encrypted (OS keychain backed) secrets store. The
 * settings UI can display and copy keys through an explicit read operation.
 */
export function createModelProviderKeys(
  store: SecretStore,
  fetchImpl: typeof fetch = fetch
): ModelProviderKeys {
  const read = async (providerId: string, protocol?: ProviderProtocol): Promise<string | null> => {
    try {
      return (
        (await store.getSecret(modelProviderSecretKey(providerId, protocol)))?.expose() ?? null
      );
    } catch {
      return null; // Secure storage unavailable: behave as if no key is stored.
    }
  };

  return {
    read,
    async hasKey(providerId: string): Promise<boolean> {
      return (
        Boolean(await read(providerId)) ||
        (await Promise.all(PROVIDER_PROTOCOLS.map((protocol) => read(providerId, protocol)))).some(
          Boolean
        )
      );
    },
    async set(providerId: string, apiKey: string, protocol?: ProviderProtocol): Promise<void> {
      const key = modelProviderSecretKey(providerId, protocol);
      await store.setSecret(key, secret(apiKey.trim(), key));
    },
    async clear(providerId: string, protocol?: ProviderProtocol): Promise<void> {
      await store.deleteSecret(modelProviderSecretKey(providerId, protocol));
    },
    /**
     * Lists the provider's upstream models (`GET <url>`), which also checks the URL and
     * key. Uses `apiKey` when given (a key being entered), else the stored one.
     */
    async listModels(input: {
      providerId: string;
      url: string;
      auth: 'bearer' | 'anthropic-bearer' | 'anthropic-api-key';
      apiKey?: string;
    }): Promise<string[]> {
      const apiKey = input.apiKey?.trim() || (await read(input.providerId));
      const headers: Record<string, string> =
        input.auth === 'bearer' ? {} : { 'anthropic-version': '2023-06-01' };
      if (apiKey) {
        if (input.auth === 'anthropic-api-key') headers['x-api-key'] = apiKey;
        else headers.Authorization = `Bearer ${apiKey}`;
      }
      const response = await fetchImpl(input.url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`The provider answered ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      return (body.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => typeof id === 'string')
        .sort((a, b) => a.localeCompare(b));
    },
  };
}
