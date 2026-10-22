import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_REASONING,
  type CodexReasoning,
  type CodexReasoningEffort,
} from '../api';
// Codex's own instructions for models it has no metadata for (openai/codex,
// codex-rs/models-manager/prompt.md at 2cf2a6a844, Apache-2.0).
import codexBaseInstructions from './codex-base-instructions.md?raw';

export type CodexCatalogModel = {
  id: string;
  contextWindow?: number;
  /** Off for models the user marked as not reasoning: no efforts are offered. */
  reasoning: boolean;
  /** The efforts the user set for this model (or its provider), if any. */
  efforts?: CodexReasoning;
};

/** The models a Codex model catalog describes; context windows only where set. */
export type CodexModelCatalog = {
  providerKey: string;
  models: CodexCatalogModel[];
};

export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CODEX_HOME ?? path.join(home, '.codex');
}

/**
 * Where Emdash keeps a provider's catalog: next to Codex's own files, as a file of its
 * own that the user's config.toml never names, so only Emdash's launches read it.
 */
export function codexModelCatalogPath(providerKey: string, home = codexHome()): string {
  return path.join(home, `emdash-model-catalog-${providerKey}.json`);
}

/**
 * What the chat UI adapter (codex-acp) runs as `codex`: it starts `codex app-server` with
 * no arguments of its own and hands config over only per thread, after Codex has already
 * read its model metadata. This passes the catalog at startup, then runs the real CLI
 * (the Codex plugin names it in EMDASH_CODEX_BIN). Windows needs a `.cmd` wrapper: the
 * adapter spawns it through the shell.
 */
export function codexAppServerWrapperPath(
  home = codexHome(),
  platform: NodeJS.Platform = process.platform
): string {
  return path.join(
    home,
    platform === 'win32' ? 'emdash-codex-app-server.cmd' : 'emdash-codex-app-server.sh'
  );
}

const APP_SERVER_WRAPPER = `#!/bin/sh
# Written by Emdash for its Codex chat conversations on a model provider.
exec "\${EMDASH_CODEX_BIN:-codex}" -c "model_catalog_json=\\"$EMDASH_CODEX_MODEL_CATALOG\\"" "$@"
`;

// TOML literal string ('…'): a Windows path's backslashes are not escapes there.
const APP_SERVER_WRAPPER_CMD = [
  '@echo off',
  'rem Written by Emdash for its Codex chat conversations on a model provider.',
  `"%EMDASH_CODEX_BIN%" -c "model_catalog_json='%EMDASH_CODEX_MODEL_CATALOG%'" %*`,
  '',
].join('\r\n');

export type CodexModelInfo = Record<string, unknown>;

/** Shown next to each effort in Codex's pickers, in the style of its own. */
const EFFORT_DESCRIPTIONS: Record<CodexReasoningEffort, string> = {
  none: 'No reasoning, fastest responses',
  minimal: 'Barely any reasoning, for quick replies',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra reasoning depth for the hardest problems',
  max: 'The most reasoning the model offers',
};

/** Codex's metadata for a model id, or for the id after a `vendor/` prefix. */
export function findKnownCodexModel(
  id: string,
  known: CodexModelInfo[]
): CodexModelInfo | undefined {
  const bare = id.slice(id.lastIndexOf('/') + 1);
  return known.find((model) => model.slug === id) ?? known.find((model) => model.slug === bare);
}

/**
 * The efforts a catalog model is offered with: none when it does not reason, the user's
 * when set (even on a model Codex knows), Codex's own for a model it knows (null: leave
 * its metadata alone), else low/medium/high.
 */
function catalogEfforts(
  model: CodexCatalogModel,
  base: CodexModelInfo | undefined
): CodexReasoning | 'off' | null {
  if (!model.reasoning) return 'off';
  if (model.efforts) return model.efforts;
  return base ? null : DEFAULT_CODEX_REASONING;
}

/**
 * The effort a launch on this model should start with: always one the catalog offers
 * it, and none at all when it does not reason (some gateways reject `none`).
 */
export function codexStartingEffort(
  model: CodexCatalogModel,
  known: CodexModelInfo[]
): CodexReasoningEffort | undefined {
  const base = findKnownCodexModel(model.id, known);
  const efforts = catalogEfforts(model, base);
  if (efforts === 'off') return undefined;
  if (efforts) return efforts.default;
  const level = base?.default_reasoning_level;
  return CODEX_REASONING_EFFORTS.find((effort) => effort === level);
}

/**
 * Codex caps a model's context at the `max_context_window` of its metadata, and models
 * it does not know get 272k. The catalog lists every provider model; a context window
 * is written only where the provider sets one (Codex accepts a missing one). A model
 * Codex knows keeps all of its metadata; others get Codex's own fallback for unknown
 * models. What changes is the context and the reasoning efforts (see catalogEfforts):
 * Codex offers no effort picker for a model whose metadata lists none.
 */
export function buildCodexModelCatalog(
  catalog: CodexModelCatalog,
  known: CodexModelInfo[]
): { models: CodexModelInfo[] } {
  return {
    models: catalog.models.map((model) => {
      const base = findKnownCodexModel(model.id, known);
      const efforts = catalogEfforts(model, base);
      return {
        ...(base ?? fallbackModelInfo(model.id)),
        slug: model.id,
        ...(model.contextWindow !== undefined && {
          context_window: model.contextWindow,
          max_context_window: model.contextWindow,
        }),
        ...(efforts === 'off'
          ? {
              supported_reasoning_levels: [],
              default_reasoning_level: null,
              supports_reasoning_effort_updates: false,
            }
          : efforts && {
              supported_reasoning_levels: efforts.levels.map((effort) => ({
                effort,
                description: EFFORT_DESCRIPTIONS[effort],
              })),
              default_reasoning_level: efforts.default,
              supports_reasoning_effort_updates: true,
            }),
      };
    }),
  };
}

/** Codex's `model_info_from_slug`, as its models API would describe it. */
function fallbackModelInfo(slug: string): CodexModelInfo {
  return {
    slug,
    display_name: slug,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: codexBaseInstructions },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_image_detail_original: false,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
  };
}

/** Writes (only when changed) the catalog a Codex launch on a provider points at. */
export async function ensureCodexModelCatalog(
  catalog: CodexModelCatalog,
  home = codexHome(),
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const known = await readKnownCodexModels(home);
  const file = codexModelCatalogPath(catalog.providerKey, home);
  const next = `${JSON.stringify(buildCodexModelCatalog(catalog, known), null, 2)}\n`;
  await writeIfChanged(file, next);
  const wrapper = codexAppServerWrapperPath(home, platform);
  await writeIfChanged(wrapper, platform === 'win32' ? APP_SERVER_WRAPPER_CMD : APP_SERVER_WRAPPER);
  if (platform !== 'win32') await chmod(wrapper, 0o755);
}

/** The model metadata Codex cached from OpenAI; empty when it never signed in here. */
export async function readKnownCodexModels(home = codexHome()): Promise<CodexModelInfo[]> {
  try {
    const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8')) as {
      models?: unknown;
    };
    return Array.isArray(cache.models) ? (cache.models as CodexModelInfo[]) : [];
  } catch {
    // No cache yet: every model uses the fallback.
    return [];
  }
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
