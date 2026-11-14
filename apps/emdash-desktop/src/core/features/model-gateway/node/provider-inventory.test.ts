import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import { gatewayProviders } from './provider-inventory';

function inventory(baseUrl: string, endpoints?: ModelProvider['endpoints']) {
  return [
    {
      provider: {
        id: 'http-provider',
        name: 'HTTP provider',
        protocol: 'openai-responses' as const,
        baseUrl,
        models: ['test-model'],
        ...(endpoints && { endpoints }),
      },
      apiKey: 'fake-key',
    },
  ];
}

describe('gateway provider inventory', () => {
  it.each([
    'http://10.0.0.10:9090/v1',
    'http://models.internal:9090/v1',
    'http://192.0.2.10:9090/v1',
  ])('accepts the explicitly configured HTTP base %s', (baseUrl) => {
    expect(gatewayProviders(inventory(baseUrl))[0]).toMatchObject({
      baseUrl,
      apiKey: 'fake-key',
      protocol: 'openai-responses',
      models: ['test-model'],
    });
  });

  it('preserves HTTP per-protocol URLs alongside HTTPS', () => {
    expect(
      gatewayProviders(
        inventory('https://models.example/v1', {
          anthropic: 'http://messages.internal:9090',
          'openai-chat': '',
          'openai-responses': 'http://responses.internal:9091/v1',
        })
      )[0]
    ).toMatchObject({
      baseUrl: 'https://models.example/v1',
      endpoints: {
        anthropic: 'http://messages.internal:9090/v1',
        'openai-chat': 'https://models.example/v1',
        'openai-responses': 'http://responses.internal:9091/v1',
      },
    });
  });

  it.each([
    'http://user:password@models.internal/v1',
    'http://models.internal/v1?api_key=secret',
    'http://models.internal/v1#fragment',
    'file:///tmp/provider',
  ])('rejects unsafe URL %s in shared and per-protocol bases', (baseUrl) => {
    expect(() => gatewayProviders(inventory(baseUrl))).toThrow('Invalid provider URL');
    expect(() =>
      gatewayProviders(
        inventory('https://models.example/v1', {
          'openai-chat': '',
          'openai-responses': baseUrl,
        })
      )
    ).toThrow('Invalid provider URL');
  });
});
