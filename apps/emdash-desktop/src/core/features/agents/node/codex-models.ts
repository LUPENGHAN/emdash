import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentModelOption } from '@core/primitives/agents/api';

type Env = { home: string; env: NodeJS.ProcessEnv };

let cached: { file: string; mtimeMs: number; options: Record<string, AgentModelOption> } | null =
  null;

/**
 * The models Codex offers this computer's account, from the list it fetches from OpenAI
 * and keeps in `models_cache.json` (refreshed by Codex itself), in Codex's own order.
 * Hidden models are left out. Features the built-in list knows about a model are kept.
 * The built-in list when the cache is missing or unreadable.
 */
export function codexModelOptions(
  builtIn: Record<string, AgentModelOption>,
  { home, env }: Env = { home: homedir(), env: process.env }
): Record<string, AgentModelOption> {
  const file = path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'models_cache.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return builtIn;
  }
  if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.options;

  let models: unknown;
  try {
    models = (JSON.parse(readFileSync(file, 'utf8')) as { models?: unknown }).models;
  } catch {
    return builtIn;
  }
  if (!Array.isArray(models)) return builtIn;
  const listed = models
    .filter(
      (model): model is Record<string, unknown> =>
        !!model &&
        typeof model === 'object' &&
        typeof model.slug === 'string' &&
        model.visibility === 'list'
    )
    .sort((a, b) => Number(a.priority ?? Infinity) - Number(b.priority ?? Infinity));
  if (listed.length === 0) return builtIn;

  const options: Record<string, AgentModelOption> = {};
  for (const model of listed) {
    const slug = model.slug as string;
    const known = builtIn[slug];
    const contextWindow =
      typeof model.context_window === 'number' ? model.context_window : undefined;
    options[slug] = {
      name: known?.name ?? displayName(model.display_name, slug),
      ...(typeof model.description === 'string'
        ? { description: model.description }
        : known?.description
          ? { description: known.description }
          : {}),
      ...((known?.modelFeatures || contextWindow) && {
        modelFeatures: {
          ...known?.modelFeatures,
          ...(contextWindow && { contextWindowSize: contextWindow }),
        },
      }),
    };
  }
  cached = { file, mtimeMs, options };
  return options;
}

/** "GPT-6-Astra" → "6 Astra", as the built-in names read. */
function displayName(value: unknown, slug: string): string {
  const name = typeof value === 'string' && value.trim() ? value.trim() : slug;
  return name.replace(/^gpt-/i, '').replace(/-/g, ' ');
}
