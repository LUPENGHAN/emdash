import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep the host model catalog and session route above user/project settings. */
export function claudeGatewaySession<T extends { _meta?: Record<string, unknown> | null }>(
  params: T,
  env: Readonly<Record<string, string>>
): T {
  const raw = env.EMDASH_CLAUDE_SETTINGS;
  if (!raw) return params;
  const gateway = record(JSON.parse(raw));
  if (
    !Array.isArray(gateway.availableModels) ||
    !gateway.availableModels.every((m) => typeof m === 'string')
  )
    throw new Error('Invalid gateway model catalog.');
  const meta = params._meta ?? {};
  const claude = record(meta.claudeCode);
  const options = record(claude.options);
  if (typeof options.settings === 'string')
    throw new Error('A settings file override cannot replace the gateway model catalog.');
  const settings = record(options.settings);
  const routing = Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_MODEL',
        'DISABLE_PROMPT_CACHING',
        'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
        'ENABLE_TOOL_SEARCH',
      ].includes(key)
    )
  );
  return {
    ...params,
    _meta: {
      ...meta,
      claudeCode: {
        ...claude,
        options: {
          ...options,
          settings: { ...settings, ...gateway, env: { ...record(settings.env), ...routing } },
        },
      },
    },
  };
}

export function configureClaudeGateway(
  connection: AcpAgentApi,
  env: Readonly<Record<string, string>>
): AcpAgentApi {
  if (!env.EMDASH_CLAUDE_SETTINGS) return connection;
  const create = connection.newSession.bind(connection);
  connection.newSession = (params) => create(claudeGatewaySession(params, env));
  const load = connection.loadSession?.bind(connection);
  if (load) connection.loadSession = (params) => load(claudeGatewaySession(params, env));
  return connection;
}
