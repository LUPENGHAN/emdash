import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentModelOption } from '@core/primitives/agents/api';

type Env = { home: string; env: NodeJS.ProcessEnv };

let cached: { file: string; mtimeMs: number; options: Record<string, AgentModelOption> } | null =
  null;

/**
 * The models Claude Code offers the signed-in account, from the model catalog it fetches
 * from Anthropic and keeps under `cache/model-catalog/` (`*-cc.json`, one per account;
 * the newest is the account in use). Its main models, in its order; older ones it lists
 * under "more" are left out. A model the built-in list has by name keeps the built-in
 * value (e.g. `opus[1m]`, which picks the 1M context). The built-in list when there is
 * no usable catalog.
 */
export function claudeModelOptions(
  builtIn: Record<string, AgentModelOption>,
  { home, env }: Env = { home: homedir(), env: process.env }
): Record<string, AgentModelOption> {
  const dir = path.join(
    env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    'cache',
    'model-catalog'
  );
  let newest: { file: string; mtimeMs: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('-cc.json')) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = statSync(file);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    }
  } catch {
    return builtIn;
  }
  if (!newest) return builtIn;
  if (cached?.file === newest.file && cached.mtimeMs === newest.mtimeMs) return cached.options;

  let models: unknown;
  try {
    const parsed = JSON.parse(readFileSync(newest.file, 'utf8')) as {
      catalog?: { config?: { models?: unknown } };
    };
    models = parsed.catalog?.config?.models;
  } catch {
    return builtIn;
  }
  if (!Array.isArray(models)) return builtIn;
  const main = models.filter(
    (model): model is Record<string, unknown> =>
      !!model &&
      typeof model === 'object' &&
      typeof model.id === 'string' &&
      typeof model.name === 'string' &&
      model.section === 'main'
  );
  if (main.length === 0) return builtIn;

  const byName = new Map(Object.entries(builtIn).map(([value, option]) => [option.name, value]));
  const options: Record<string, AgentModelOption> = {};
  for (const model of main) {
    const name = model.name as string;
    const value = byName.get(name) ?? (model.id as string);
    const known = builtIn[value];
    options[value] = {
      name,
      ...(typeof model.description === 'string' && model.description
        ? { description: model.description }
        : known?.description
          ? { description: known.description }
          : {}),
      ...(known?.modelFeatures && { modelFeatures: known.modelFeatures }),
    };
  }
  cached = { file: newest.file, mtimeMs: newest.mtimeMs, options };
  return options;
}
