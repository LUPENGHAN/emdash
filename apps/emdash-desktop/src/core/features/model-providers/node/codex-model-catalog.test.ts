import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCodexModelCatalog,
  codexAppServerWrapperPath,
  codexModelCatalogPath,
  ensureCodexModelCatalog,
} from './codex-model-catalog';

describe('Codex model catalog', () => {
  const known = [
    {
      slug: 'gpt-6-sol',
      display_name: 'GPT-6 Sol',
      context_window: 272_000,
      max_context_window: 872_000,
      model_messages: { instructions_template: 'gpt-6 instructions' },
      apply_patch_tool_type: 'freeform',
    },
  ];

  it('keeps what Codex knows of a model, prefixed or not, and only widens its context', () => {
    const { models } = buildCodexModelCatalog(
      {
        providerKey: 'emdash-x',
        models: [
          { id: 'gpt-6-sol', contextWindow: 1_000_000 },
          { id: 'openai/gpt-6-sol', contextWindow: 1_000_000 },
        ],
      },
      known
    );
    for (const [model, slug] of [
      [models[0], 'gpt-6-sol'],
      [models[1], 'openai/gpt-6-sol'],
    ] as const) {
      expect(model).toMatchObject({
        slug,
        display_name: 'GPT-6 Sol',
        apply_patch_tool_type: 'freeform',
        model_messages: { instructions_template: 'gpt-6 instructions' },
        context_window: 1_000_000,
        max_context_window: 1_000_000,
      });
    }
  });

  it("describes unknown models with Codex's own fallback and its base instructions", () => {
    const [model] = buildCodexModelCatalog(
      { providerKey: 'emdash-x', models: [{ id: 'deepseek/v4-flash', contextWindow: 128_000 }] },
      known
    ).models;
    expect(model).toMatchObject({
      slug: 'deepseek/v4-flash',
      display_name: 'deepseek/v4-flash',
      supported_reasoning_levels: [],
      context_window: 128_000,
      max_context_window: 128_000,
    });
    const messages = model?.model_messages as { instructions_template: string } | undefined;
    const instructions = messages?.instructions_template;
    expect(instructions).toMatch(/^You are a coding agent running in the Codex CLI/);
  });

  describe('on disk', () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("writes the provider's catalog next to Codex's files, from its model cache", async () => {
      await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: known }));
      await ensureCodexModelCatalog(
        { providerKey: 'emdash-x', models: [{ id: 'gpt-6-sol', contextWindow: 1_000_000 }] },
        home
      );
      const file = codexModelCatalogPath('emdash-x', home);
      expect(path.dirname(file)).toBe(home);
      const written = JSON.parse(await readFile(file, 'utf8'));
      expect(written.models[0]).toMatchObject({ slug: 'gpt-6-sol', context_window: 1_000_000 });
      // The chat UI's Codex gets the catalog through an executable wrapper.
      const wrapper = codexAppServerWrapperPath(home);
      expect((await stat(wrapper)).mode & 0o111).not.toBe(0);
      expect(await readFile(wrapper, 'utf8')).toContain(
        'exec "${EMDASH_CODEX_BIN:-codex}" -c "model_catalog_json=\\"$EMDASH_CODEX_MODEL_CATALOG\\"" "$@"'
      );
    });
  });
});
