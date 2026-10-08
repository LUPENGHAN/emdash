import { stat } from 'node:fs/promises';
import path from 'node:path';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import { providerConfigId, type ModelProvider } from '@core/features/model-providers/api';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api/app-settings';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects } from '@core/services/app-db/node/schema';
import { openCodeDbPath, openOpenCodeDb, piSessionsDir } from '../external-sessions';
import type { OpenCodeCall, SessionRoot, UsageAgent } from './session-records';
import type { UsageAttribution } from './usage-stats-service';

const USAGE_AGENTS: UsageAgent[] = ['claude', 'codex', 'pi', 'oh-my-pi', 'opencode'];

/**
 * Where each agent keeps its sessions, given Claude Code's and Codex's config dirs.
 * Official accounts' own config dirs link their sessions into these, so one set covers
 * every account.
 */
export function usageSessionRoots(
  homes: { claude: string; codex: string },
  env: { home: string; env: NodeJS.ProcessEnv }
): SessionRoot[] {
  return [
    { agent: 'claude', dir: path.join(homes.claude, 'projects') },
    { agent: 'codex', dir: path.join(homes.codex, 'sessions') },
    { agent: 'codex', dir: path.join(homes.codex, 'archived_sessions') },
    { agent: 'pi', dir: piSessionsDir('pi', env) },
    { agent: 'oh-my-pi', dir: piSessionsDir('oh-my-pi', env) },
  ];
}

/**
 * Reads OpenCode's calls from its database: every assistant message records its tokens,
 * model and provider. The read blocks for a fraction of a second, so it happens again only
 * once the database has changed. No database (OpenCode never ran) means no calls.
 */
export function createOpenCodeCallReader(env: {
  home: string;
  env: NodeJS.ProcessEnv;
}): () => Promise<OpenCodeCall[]> {
  let last: { key: string; calls: OpenCodeCall[] } | null = null;
  return async () => {
    const file = openCodeDbPath(env);
    const parts: string[] = [];
    for (const name of [file, `${file}-wal`]) {
      const info = await stat(name).catch(() => null);
      parts.push(info ? `${info.mtimeMs}:${info.size}` : '-');
    }
    if (parts[0] === '-') return [];
    const key = parts.join('|');
    if (last?.key === key) return last.calls;
    const db = openOpenCodeDb(env);
    try {
      const rows = db
        .prepare(
          `SELECT COALESCE(s.parent_id, s.id) AS sessionId, s.directory AS cwd,
             m.time_created AS time,
             json_extract(m.data, '$.modelID') AS model,
             json_extract(m.data, '$.providerID') AS provider,
             json_extract(m.data, '$.tokens.input') AS input,
             json_extract(m.data, '$.tokens.output') AS output,
             json_extract(m.data, '$.tokens.reasoning') AS reasoning,
             json_extract(m.data, '$.tokens.cache.read') AS cacheRead,
             json_extract(m.data, '$.tokens.cache.write') AS cacheWrite
           FROM message m JOIN session s ON s.id = m.session_id
           WHERE json_extract(m.data, '$.role') = 'assistant'`
        )
        .all() as Record<string, unknown>[];
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0;
      const calls = rows.map(
        (row): OpenCodeCall => ({
          sessionId: String(row.sessionId),
          cwd: typeof row.cwd === 'string' ? row.cwd : null,
          time: count(row.time),
          model: typeof row.model === 'string' && row.model ? row.model : 'unknown',
          provider: typeof row.provider === 'string' && row.provider ? row.provider : null,
          input: count(row.input),
          output: count(row.output),
          reasoning: count(row.reasoning),
          cacheRead: count(row.cacheRead),
          cacheWrite: count(row.cacheWrite),
        })
      );
      last = { key, calls };
      return calls;
    } finally {
      db.close();
    }
  };
}

/** What Emdash's database and settings say about the sessions it started. */
export async function readUsageAttribution(deps: {
  db: Pick<AppDb, 'select'>;
  providers: () => Promise<ModelProvider[]>;
  agentConfig: (agentId: string) => Promise<ProviderCustomConfig | undefined>;
}): Promise<UsageAttribution> {
  const [conversationRows, projectRows, providers] = await Promise.all([
    deps.db
      .select({
        sessionId: conversations.providerSessionId,
        config: conversations.config,
        projectId: conversations.projectId,
      })
      .from(conversations),
    deps.db.select({ id: projects.id, name: projects.name }).from(projects),
    deps.providers(),
  ]);
  const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
  const byConversation: UsageAttribution['conversations'] = new Map();
  for (const row of conversationRows) {
    if (!row.sessionId) continue;
    const config = row.config as { modelSource?: string | null } | null;
    byConversation.set(row.sessionId, {
      modelSource: config && 'modelSource' in config ? config.modelSource : undefined,
      project: (row.projectId && projectNames.get(row.projectId)) || null,
    });
  }
  const agentDefaults: UsageAttribution['agentDefaults'] = {};
  for (const agent of USAGE_AGENTS) {
    agentDefaults[agent] = (await deps.agentConfig(agent))?.modelSource;
  }
  return {
    conversations: byConversation,
    agentDefaults,
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      ...(provider.account && { account: provider.account }),
      configId: providerConfigId(provider),
    })),
  };
}
