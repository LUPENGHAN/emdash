import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { AgentProviderFile } from './source-launch';

type Env = { home: string; env: NodeJS.ProcessEnv };

/** Where Pi and Oh My Pi read custom providers from. */
export function agentProviderFilePath(agent: AgentProviderFile['agent'], { home, env }: Env) {
  return agent === 'pi'
    ? path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), 'models.json')
    : path.join(home, '.omp', 'agent', 'models.yml');
}

/**
 * Upserts Emdash's own provider entry (`providers.<emdash-…>`) and leaves everything else
 * in the user's file untouched; the file is only rewritten when the entry changed. The
 * entry holds no secret: its apiKey references the env var Emdash sets at launch.
 */
export async function ensureAgentProviderFile(
  file: AgentProviderFile,
  env: Env = { home: homedir(), env: process.env }
): Promise<void> {
  const filePath = agentProviderFilePath(file.agent, env);
  let current = '';
  try {
    current = await readFile(filePath, 'utf8');
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
  }
  const next = file.agent === 'pi' ? upsertJson(current, file) : upsertYaml(current, file);
  if (next !== current) await writeFile(filePath, next);
}

function upsertJson(current: string, file: AgentProviderFile): string {
  const config = current.trim() ? (JSON.parse(current) as Record<string, unknown>) : {};
  const providers = (config.providers ?? {}) as Record<string, unknown>;
  if (JSON.stringify(providers[file.providerKey]) === JSON.stringify(file.entry)) return current;
  providers[file.providerKey] = file.entry;
  config.providers = providers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function upsertYaml(current: string, file: AgentProviderFile): string {
  // A Document keeps the user's comments and formatting around our entry.
  const doc = parseDocument(current || '{}');
  const existing = doc.getIn(['providers', file.providerKey]) as { toJSON?: () => unknown };
  if (JSON.stringify(existing?.toJSON?.() ?? existing) === JSON.stringify(file.entry)) {
    return current;
  }
  doc.setIn(['providers', file.providerKey], doc.createNode(file.entry));
  return doc.toString();
}
