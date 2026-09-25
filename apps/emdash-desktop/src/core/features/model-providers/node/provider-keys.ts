import { secret } from '@emdash/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { modelProviderSecretKey, openAiBaseUrl, type ModelProviderKeys } from '../api';

/**
 * Provider API keys, kept in the encrypted (OS keychain backed) secrets store. The
 * renderer can set, clear and check a key, but never read one back.
 */
export function createModelProviderKeys(
  store: SecretStore,
  fetchImpl: typeof fetch = fetch
): ModelProviderKeys {
  const read = async (providerId: string): Promise<string | null> => {
    try {
      return (await store.getSecret(modelProviderSecretKey(providerId)))?.expose() ?? null;
    } catch {
      return null; // Secure storage unavailable: behave as if no key is stored.
    }
  };

  return {
    read,
    async hasKey(providerId: string): Promise<boolean> {
      return (await read(providerId)) !== null;
    },
    async set(providerId: string, apiKey: string): Promise<void> {
      const key = modelProviderSecretKey(providerId);
      await store.setSecret(key, secret(apiKey.trim(), key));
    },
    async clear(providerId: string): Promise<void> {
      await store.deleteSecret(modelProviderSecretKey(providerId));
    },
    /**
     * Lists the gateway's models (`GET /v1/models`), which also checks the URL and key.
     * Uses `apiKey` when given (a key being entered), else the stored one.
     */
    async listModels(input: {
      providerId: string;
      baseUrl: string;
      apiKey?: string;
    }): Promise<string[]> {
      const apiKey = input.apiKey?.trim() || (await read(input.providerId));
      const response = await fetchImpl(`${openAiBaseUrl(input.baseUrl)}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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
