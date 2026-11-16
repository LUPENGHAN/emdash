import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { expect, it, vi } from 'vitest';
import { claudeGatewaySession, configureClaudeGateway } from './model-settings';

const env = {
  EMDASH_CLAUDE_SETTINGS: JSON.stringify({
    availableModels: ['fast', 'main'],
    modelPicker: { replaceBuiltInOptions: true, options: [{ model: 'fast' }, { model: 'main' }] },
  }),
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/sessions/one',
  ANTHROPIC_AUTH_TOKEN: 'fake-local-capability',
};
it('injects the public model directory and route into per-session settings without changing caller data', () => {
  const input = {
    cwd: '/work',
    mcpServers: [],
    _meta: {
      other: 'preserved',
      claudeCode: {
        options: {
          settings: {
            alwaysThinkingEnabled: false,
            env: { OTHER: 'keep', ANTHROPIC_BASE_URL: 'https://other.example' },
          },
          maxTurns: 2,
        },
      },
    },
  };
  const copy = structuredClone(input);
  const result = claudeGatewaySession(input, env);
  expect(result).toMatchObject({
    cwd: '/work',
    _meta: {
      other: 'preserved',
      claudeCode: {
        options: {
          maxTurns: 2,
          settings: {
            alwaysThinkingEnabled: false,
            availableModels: ['fast', 'main'],
            env: {
              OTHER: 'keep',
              ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
              ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
            },
          },
        },
      },
    },
  });
  expect(input).toEqual(copy);
  expect(claudeGatewaySession(input, {})).toBe(input);
});
it('wraps create and resume while retaining the connection and its protocol methods', async () => {
  const newSession = vi.fn().mockResolvedValue({ sessionId: 'one' });
  const loadSession = vi.fn().mockResolvedValue({});
  const connection = {
    initialize: vi.fn(),
    newSession,
    loadSession,
    prompt: vi.fn(),
    cancel: vi.fn(),
  } as unknown as AcpAgentApi;
  expect(configureClaudeGateway(connection, env)).toBe(connection);
  await connection.newSession({ cwd: '/work', mcpServers: [] });
  await connection.loadSession?.({ cwd: '/work', mcpServers: [], sessionId: 'one' });
  expect(newSession).toHaveBeenCalledWith(
    expect.objectContaining({ _meta: expect.objectContaining({ claudeCode: expect.any(Object) }) })
  );
  expect(loadSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'one', _meta: expect.any(Object) })
  );
  expect(() =>
    claudeGatewaySession({ _meta: { claudeCode: { options: { settings: '/other.json' } } } }, env)
  ).toThrow('settings file override');
});
