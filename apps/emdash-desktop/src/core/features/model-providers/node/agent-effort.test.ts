import { describe, expect, it } from 'vitest';
import { conversationConfig } from '@core/primitives/conversations/api/conversation-config';
import { providerCustomConfigEntrySchema } from '@core/services/settings/node/provider-config-schema';
import { sourceOverrideOf, type ModelProvider } from '../api';
import { withAgentEffort } from '../api/node/agent-effort';
import {
  createEffectiveAgentConfig,
  type EffectiveAgentConfigDeps,
} from './effective-agent-config';

const provider: ModelProvider = {
  id: 'test',
  name: 'Test',
  baseUrl: 'http://localhost:1234/v1',
  models: ['code'],
};

function resolver(config: Parameters<typeof withAgentEffort>[1]) {
  const deps: EffectiveAgentConfigDeps = {
    getAgentConfig: async () => config,
    getProviders: async () => [provider],
    getApiKey: async () => 'test-key',
    prepareAgentProvider: async () => {},
    prepareAccountHome: async () => '/tmp/test-account',
  };
  return createEffectiveAgentConfig(deps);
}

describe('default agent effort', () => {
  it('round trips optional settings without changing historical empty settings', () => {
    expect(providerCustomConfigEntrySchema.parse({})).toEqual({});
    expect(
      providerCustomConfigEntrySchema.parse(JSON.parse(JSON.stringify({ effort: 'high' })))
    ).toEqual({ effort: 'high' });
    expect(providerCustomConfigEntrySchema.safeParse({ effort: '' }).success).toBe(false);
  });

  it('applies Claude defaults to both the CLI arguments and adapter environment', async () => {
    const launch = await resolver({ effort: 'high', env: { CUSTOM: 'keep' } })('claude');
    expect(launch?.env).toEqual({ CUSTOM: 'keep', CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    expect(launch?.extraArgs).toBe('--effort high');
  });

  it('applies Codex defaults after source launch config without losing the provider', async () => {
    const launch = await resolver({ effort: 'high', modelSource: 'test', sourceModel: 'code' })(
      'codex'
    );
    const config = JSON.parse(launch!.env!.CODEX_CONFIG);
    expect(config.model_reasoning_effort).toBe('high');
    expect(config.model_providers).toBeDefined();
    expect(launch?.extraArgs).toContain('-c model_reasoning_effort=high');
  });

  it('lets explicit session effort override or clear the agent default', async () => {
    const resolve = resolver({ effort: 'high' });
    expect((await resolve('claude', { effort: 'low' }))?.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
    expect(
      (await resolve('claude', { effort: null }))?.env?.CLAUDE_CODE_EFFORT_LEVEL
    ).toBeUndefined();
  });

  it('retains Codex context and user configuration on official login', async () => {
    const launch = await resolver({
      effort: 'low',
      contextWindow: 100_000,
      env: { CODEX_CONFIG: '{"custom":true}' },
    })('codex');
    expect(JSON.parse(launch!.env!.CODEX_CONFIG)).toMatchObject({
      custom: true,
      model_context_window: 100_000,
      model_reasoning_effort: 'low',
    });
  });

  it('rejects unsupported effort and disabled reasoning rather than ignoring them', () => {
    expect(() => withAgentEffort('codex', { effort: 'max' })).toThrow('does not support');
    expect(() =>
      withAgentEffort(
        'claude',
        { effort: 'high' },
        {
          ...provider,
          nonReasoningModels: ['code'],
        },
        'code'
      )
    ).toThrow('reasoning disabled');
    expect(() =>
      withAgentEffort(
        'codex',
        { effort: 'high' },
        {
          ...provider,
          codexReasoning: { levels: ['low'], default: 'low' },
        },
        'code'
      )
    ).toThrow('does not support');
  });

  it('preserves a frozen effort through persisted config and restart source resolution', async () => {
    const frozen = conversationConfig.schema.parse(
      JSON.parse(
        JSON.stringify({
          version: '1',
          type: 'pty',
          effort: 'low',
          modelSource: null,
        })
      )
    );
    const launch = await resolver({ effort: 'high' })(
      'claude',
      sourceOverrideOf(frozen, 'conversation')
    );
    expect(launch?.effort).toBe('low');
    expect(launch?.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
  });

  it('retains explicit ACP effort changes and the adapter default across restart', () => {
    expect(sourceOverrideOf({ effort: 'low', options: { effort: 'high' } })?.effort).toBe('high');
    expect(sourceOverrideOf({ effort: 'high', options: { effort: 'default' } })?.effort).toBeNull();
    expect(sourceOverrideOf({ effort: null })?.effort).toBeNull();
  });

  it('rejects malformed Codex adapter config rather than replacing user configuration', () => {
    expect(() => withAgentEffort('codex', { effort: 'high', env: { CODEX_CONFIG: '[' } })).toThrow(
      'valid JSON'
    );
  });
});
