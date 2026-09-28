import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
// Codex's own instructions for models it has no metadata for (openai/codex,
// codex-rs/models-manager/prompt.md at 2cf2a6a844, Apache-2.0).
import codexBaseInstructions from './codex-base-instructions.md?raw';

/** The models (with their context windows) a Codex model catalog describes. */
export type CodexModelCatalog = {
  providerKey: string;
  models: { id: string; contextWindow: number }[];
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
 * (the Codex plugin names it in EMDASH_CODEX_BIN).
 */
export function codexAppServerWrapperPath(home = codexHome()): string {
  return path.join(home, 'emdash-codex-app-server.sh');
}

const APP_SERVER_WRAPPER = `#!/bin/sh
# Written by Emdash for its Codex chat conversations on a model provider.
exec "\${EMDASH_CODEX_BIN:-codex}" -c "model_catalog_json=\\"$EMDASH_CODEX_MODEL_CATALOG\\"" "$@"
`;

type ModelInfo = Record<string, unknown>;

/**
 * Codex caps a model's context at the `max_context_window` of its metadata, and models
 * it does not know get 272k; a catalog (`model_catalog_json`) is the only way past that.
 * A model Codex knows (by id, or by the id after a `vendor/` prefix) keeps all of its
 * metadata; others get Codex's own fallback for unknown models. Only the context changes.
 */
export function buildCodexModelCatalog(
  catalog: CodexModelCatalog,
  known: ModelInfo[]
): { models: ModelInfo[] } {
  return {
    models: catalog.models.map(({ id, contextWindow }) => {
      const bare = id.slice(id.lastIndexOf('/') + 1);
      const base =
        known.find((model) => model.slug === id) ?? known.find((model) => model.slug === bare);
      return {
        ...(base ?? fallbackModelInfo(id)),
        slug: id,
        context_window: contextWindow,
        max_context_window: contextWindow,
      };
    }),
  };
}

/** Codex's `model_info_from_slug`, as its models API would describe it. */
function fallbackModelInfo(slug: string): ModelInfo {
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
  home = codexHome()
): Promise<void> {
  let known: ModelInfo[] = [];
  try {
    const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8')) as {
      models?: unknown;
    };
    if (Array.isArray(cache.models)) known = cache.models as ModelInfo[];
  } catch {
    // No cache yet (Codex never signed in here): every model uses the fallback.
  }
  const file = codexModelCatalogPath(catalog.providerKey, home);
  const next = `${JSON.stringify(buildCodexModelCatalog(catalog, known), null, 2)}\n`;
  await writeIfChanged(file, next);
  const wrapper = codexAppServerWrapperPath(home);
  await writeIfChanged(wrapper, APP_SERVER_WRAPPER);
  await chmod(wrapper, 0o755);
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
