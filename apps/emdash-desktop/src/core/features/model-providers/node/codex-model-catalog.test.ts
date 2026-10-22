import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodexReasoning } from '../api';
import {
  buildCodexModelCatalog,
  codexAppServerWrapperPath,
  codexModelCatalogPath,
  codexStartingEffort,
  ensureCodexModelCatalog,
  readKnownCodexModels,
} from './codex-model-catalog';

describe('Codex model catalog', () => {
  const known = [
    {
      slug: 'gpt-6-sol',
      display_name: 'GPT-6 Sol',
      context_window: 272_000,
      max_context_window: 872_000,
      default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
      supports_reasoning_effort_updates: true,
      model_messages: { instructions_template: 'gpt-6 instructions' },
      apply_patch_tool_type: 'freeform',
    },
  ];

  it('keeps what Codex knows of a model, prefixed or not, and only widens its context', () => {
    const { models } = buildCodexModelCatalog(
      {
        providerKey: 'emdash-x',
        models: [
          { id: 'gpt-6-sol', contextWindow: 1_000_000, reasoning: true },
          { id: 'openai/gpt-6-sol', contextWindow: 1_000_000, reasoning: true },
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
      {
        providerKey: 'emdash-x',
        models: [{ id: 'deepseek/v4-flash', contextWindow: 128_000, reasoning: true }],
      },
      known
    ).models;
    expect(model).toMatchObject({
      slug: 'deepseek/v4-flash',
      display_name: 'deepseek/v4-flash',
      context_window: 128_000,
      max_context_window: 128_000,
    });
    const messages = model?.model_messages as { instructions_template: string } | undefined;
    const instructions = messages?.instructions_template;
    expect(instructions).toMatch(/^You are a coding agent running in the Codex CLI/);
  });

  it('leaves the context window unset when the provider does not set one', () => {
    // A model Codex knows keeps its own context (272k); the catalog no longer
    // overrides it, and an unknown model gets no context_window at all.
    const [knownModel, unknownModel] = buildCodexModelCatalog(
      {
        providerKey: 'emdash-x',
        models: [
          { id: 'gpt-6-sol', reasoning: true },
          { id: 'deepseek/v4-flash', reasoning: true },
        ],
      },
      known
    ).models;
    expect(knownModel).toMatchObject({
      slug: 'gpt-6-sol',
      display_name: 'GPT-6 Sol',
      context_window: 272_000,
    });
    expect(unknownModel).toMatchObject({ slug: 'deepseek/v4-flash' });
    expect(unknownModel).not.toHaveProperty('context_window');
    expect(unknownModel).not.toHaveProperty('max_context_window');
  });

  describe('reasoning efforts', () => {
    const levels = (model: Record<string, unknown> | undefined) =>
      ((model?.supported_reasoning_levels ?? []) as { effort: string }[]).map((l) => l.effort);
    const build = (models: Parameters<typeof buildCodexModelCatalog>[0]['models']) =>
      buildCodexModelCatalog({ providerKey: 'emdash-x', models }, known).models;

    it('offers none for a model that does not reason, known or not, set or not', () => {
      const efforts: CodexReasoning = { levels: ['low', 'high'], default: 'high' };
      for (const model of build([
        { id: 'gpt-6-sol', reasoning: false },
        { id: 'deepseek/v4-flash', reasoning: false, efforts },
      ])) {
        expect(model).toMatchObject({
          supported_reasoning_levels: [],
          default_reasoning_level: null,
          supports_reasoning_effort_updates: false,
        });
      }
    });

    it("uses the user's efforts on known and unknown models alike", () => {
      const efforts: CodexReasoning = { levels: ['low', 'high', 'max'], default: 'max' };
      const models = build([
        { id: 'gpt-6-sol', reasoning: true, efforts },
        { id: 'deepseek/v4-flash', reasoning: true, efforts },
      ]);
      for (const model of models) {
        expect(levels(model)).toEqual(['low', 'high', 'max']);
        expect(model).toMatchObject({
          default_reasoning_level: 'max',
          supports_reasoning_effort_updates: true,
        });
      }
      expect(models[0]?.supported_reasoning_levels).toContainEqual({
        effort: 'max',
        description: 'The most reasoning the model offers',
      });
    });

    it("keeps Codex's own efforts for a model it knows when none are set", () => {
      const [model] = build([{ id: 'openai/gpt-6-sol', reasoning: true }]);
      expect(levels(model)).toEqual(['medium', 'high']);
      expect(model?.default_reasoning_level).toBe('high');
    });

    it('offers low/medium/high from medium for an unknown model when none are set', () => {
      const [model] = build([{ id: 'deepseek/v4-flash', reasoning: true }]);
      expect(levels(model)).toEqual(['low', 'medium', 'high']);
      expect(model).toMatchObject({
        default_reasoning_level: 'medium',
        supports_reasoning_effort_updates: true,
      });
    });

    it('starts a launch at an effort the catalog offers', () => {
      const start = (model: Parameters<typeof codexStartingEffort>[0]) =>
        codexStartingEffort(model, known);
      expect(start({ id: 'deepseek/v4-flash', reasoning: true })).toBe('medium');
      expect(start({ id: 'gpt-6-sol', reasoning: true })).toBe('high');
      expect(
        start({ id: 'gpt-6-sol', reasoning: true, efforts: { levels: ['low'], default: 'low' } })
      ).toBe('low');
      expect(start({ id: 'gpt-6-sol', reasoning: false })).toBeUndefined();
      // Without Codex's cache every model counts as unknown.
      expect(codexStartingEffort({ id: 'gpt-6-sol', reasoning: true }, [])).toBe('medium');
    });
  });

  it('names a Windows wrapper .cmd', () => {
    expect(codexAppServerWrapperPath('/home', 'win32')).toBe('/home/emdash-codex-app-server.cmd');
    expect(codexAppServerWrapperPath('/home', 'darwin')).toBe('/home/emdash-codex-app-server.sh');
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
        {
          providerKey: 'emdash-x',
          models: [{ id: 'gpt-6-sol', contextWindow: 1_000_000, reasoning: true }],
        },
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

    it("reads Codex's model cache, or nothing when there is none", async () => {
      expect(await readKnownCodexModels(home)).toEqual([]);
      await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: known }));
      expect(await readKnownCodexModels(home)).toEqual(known);
    });

    it('writes a Windows .cmd wrapper with a TOML literal and no chmod', async () => {
      await ensureCodexModelCatalog(
        {
          providerKey: 'emdash-x',
          models: [{ id: 'gpt-6-sol', contextWindow: 1_000_000, reasoning: true }],
        },
        home,
        'win32'
      );
      const wrapper = codexAppServerWrapperPath(home, 'win32');
      const content = await readFile(wrapper, 'utf8');
      expect(content).toContain(`-c "model_catalog_json='%EMDASH_CODEX_MODEL_CATALOG%'" %*`);
      expect(content).toContain('\r\n');
      // The Windows wrapper runs through the shell; no executable bit is needed.
      expect((await stat(wrapper)).mode & 0o111).toBe(0);
    });
  });
});
