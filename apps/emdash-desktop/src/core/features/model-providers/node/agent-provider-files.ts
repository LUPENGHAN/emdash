import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createLocalPluginFs } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { parseDocument } from 'yaml';
import { getPlugin } from '@core/features/agents/api/node/plugin-registry';
import { PROVIDER_KEY_ENV, type ExtensionProviderAgent } from './source-launch';

type Env = { home: string; env: NodeJS.ProcessEnv };

const defaultEnv = (): Env => ({ home: homedir(), env: process.env });

/** Where Pi and Oh My Pi read custom providers from. */
export function agentProviderFilePath(agent: ExtensionProviderAgent, { home, env }: Env) {
  return agent === 'pi'
    ? path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), 'models.json')
    : path.join(home, '.omp', 'agent', 'models.yml');
}

/**
 * Readies Pi / Oh My Pi to run on a provider. Emdash's own extension (which also reports
 * session status) registers the provider inside the launched process from its env, so
 * it must be current before the launch; the chat adapter's launch does not install it
 * on its own. Entries earlier versions wrote into the user's model file are removed:
 * the agent layers that file over registered providers, so a stale one would win.
 */
export async function prepareAgentProvider(
  agent: ExtensionProviderAgent,
  env: Env = defaultEnv()
): Promise<void> {
  await ensureEmdashExtension(agent, env);
  await removeLegacyProviderEntries(agent, env);
}

async function ensureEmdashExtension(agent: ExtensionProviderAgent, { home, env }: Env) {
  const plugins = getPlugin(agent).behavior.plugins;
  if (!plugins) return;
  const root = plugins.resolveConfigRoot({
    env,
    homeDir: home,
    platform:
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
  });
  const fs = createLocalPluginFs(root);
  if (!(await plugins.isPluginInstalled(fs, { kind: 'global' }))) {
    await plugins.installPlugin(fs, { kind: 'global' });
  }
}

/** Emdash's entries: `emdash-…` providers whose key is Emdash's launch variable. */
function isLegacyEntry(key: string, entry: unknown): boolean {
  const apiKey = (entry as { apiKey?: unknown } | null)?.apiKey;
  return (
    key.startsWith('emdash-') &&
    typeof apiKey === 'string' &&
    apiKey.replace(/^\$/, '') === PROVIDER_KEY_ENV
  );
}

/** Drops only Emdash's entries; the file is left alone unless it had one. */
export async function removeLegacyProviderEntries(
  agent: ExtensionProviderAgent,
  env: Env = defaultEnv()
): Promise<void> {
  const filePath = agentProviderFilePath(agent, env);
  let current: string;
  try {
    current = await readFile(filePath, 'utf8');
  } catch {
    return;
  }
  const next = agent === 'pi' ? withoutLegacyJson(current) : withoutLegacyYaml(current);
  if (next === current) return;
  if (next === null) await rm(filePath, { force: true });
  else await writeFile(filePath, next);
}

/** The file without Emdash's entries; null when nothing else was in it. */
function withoutLegacyJson(current: string): string | null {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(current) as Record<string, unknown>;
  } catch {
    return current;
  }
  const providers = config.providers as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== 'object') return current;
  const legacy = Object.keys(providers).filter((key) => isLegacyEntry(key, providers[key]));
  if (legacy.length === 0) return current;
  for (const key of legacy) delete providers[key];
  if (Object.keys(providers).length === 0) delete config.providers;
  return Object.keys(config).length === 0 ? null : `${JSON.stringify(config, null, 2)}\n`;
}

function withoutLegacyYaml(current: string): string | null {
  // A Document keeps the user's comments and formatting around what is removed.
  const doc = parseDocument(current);
  if (doc.errors.length > 0) return current;
  const config = doc.toJSON() as Record<string, unknown> | null;
  const providers = config?.providers as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== 'object') return current;
  const legacy = Object.keys(providers).filter((key) => isLegacyEntry(key, providers[key]));
  if (legacy.length === 0) return current;
  for (const key of legacy) doc.deleteIn(['providers', key]);
  if (legacy.length === Object.keys(providers).length) doc.delete('providers');
  const rest = doc.toJSON() as Record<string, unknown> | null;
  return !rest || Object.keys(rest).length === 0 ? null : doc.toString();
}
