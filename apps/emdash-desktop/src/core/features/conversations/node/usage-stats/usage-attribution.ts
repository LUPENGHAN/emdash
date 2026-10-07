import path from 'node:path';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import { providerConfigId, type ModelProvider } from '@core/features/model-providers/api';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api/app-settings';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects } from '@core/services/app-db/node/schema';
import { piSessionsDir } from '../external-sessions';
import type { SessionRoot, UsageAgent } from './session-records';
import type { UsageAttribution } from './usage-stats-service';

const USAGE_AGENTS: UsageAgent[] = ['claude', 'codex', 'pi', 'oh-my-pi'];

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
