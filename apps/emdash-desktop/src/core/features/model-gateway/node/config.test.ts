import { describe, expect, it } from 'vitest';
import { apiProviders } from './config';

describe('gateway configuration', () => {
  it('decodes legacy aliases and headers for migration to Providers', () => {
    const config = {
      'api-keys': {
        codex: [
          {
            'base-url': 'https://example.test/v1',
            headers: { 'x-private': 'header-secret' },
            keys: [{ 'api-key': 'private-key', models: [{ name: 'upstream', alias: 'public' }] }],
          },
        ],
      },
    };
    expect(apiProviders(config)[0]).toMatchObject({
      apiKey: 'private-key',
      models: ['public'],
      modelMap: { public: 'upstream' },
      headers: { 'x-private': 'header-secret' },
    });
  });
  it('accepts explicitly configured HTTP providers while rejecting unsafe URLs', () => {
    const entry = (url: string) => ({
      'api-keys': {
        codex: [{ 'base-url': url, keys: [{ 'api-key': 'key', models: [{ name: 'm' }] }] }],
      },
    });
    expect(apiProviders(entry('http://remote.test/v1'))[0]?.baseUrl).toBe('http://remote.test/v1');
    expect(() => apiProviders(entry('https://user:password@remote.test/v1'))).toThrow('embedded');
    expect(() => apiProviders(entry('file:///tmp/provider'))).toThrow('HTTP or HTTPS');
    expect(() => apiProviders(entry('http://remote.test/v1?api_key=secret'))).toThrow('embedded');
    expect(apiProviders(entry('http://127.0.0.1:1234/v1'))).toHaveLength(1);
    const disabled = entry('http://127.0.0.1:1234/v1');
    Object.assign(disabled['api-keys'].codex[0].keys[0], { 'excluded-models': ['*'] });
    expect(apiProviders(disabled)).toHaveLength(0);
  });
});
