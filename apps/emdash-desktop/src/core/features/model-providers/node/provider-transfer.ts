import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  describeProvider,
  modelProviderSchema,
  type ModelProvider,
  type ModelProviderKeys,
  type ModelProviderTransfer,
} from '../api';

export const PROVIDER_EXPORT_FORMAT = 'emdash-model-providers';

const exportFileSchema = z.object({
  format: z.literal(PROVIDER_EXPORT_FORMAT),
  version: z.literal(1),
  providers: z.array(z.unknown()),
});

const exportedProviderSchema = modelProviderSchema.extend({ apiKey: z.string().optional() });

type ImportEntry = { provider: ModelProvider; apiKey: string | null };

export type ProviderTransferDeps = {
  getProviders: () => Promise<ModelProvider[]>;
  saveProviders: (providers: ModelProvider[]) => Promise<void>;
  keys: Pick<ModelProviderKeys, 'read' | 'set' | 'clear'>;
  /** Where to write the export; undefined when the user cancels. */
  pickExportPath: (defaultName: string) => Promise<string | undefined>;
  /** Which file to import; undefined when the user cancels. */
  pickImportPath: () => Promise<string | undefined>;
  readText?: (file: string) => Promise<string>;
  writeText?: (file: string, text: string, mode: number) => Promise<void>;
};

/**
 * Moves API providers between computers through a JSON file. Keys go into the file only
 * when asked, and the file is read and written here, so a key never reaches the renderer.
 * Official accounts are not exported: their logins live in this computer's config dirs.
 */
export function createProviderTransfer(deps: ProviderTransferDeps): ModelProviderTransfer {
  const readText = deps.readText ?? ((file: string) => readFile(file, 'utf8'));
  const writeText = deps.writeText ?? writeNewFile;
  /** The last file read for import, until it is imported or another is read. */
  let pending: { token: string; entries: ImportEntry[] } | null = null;

  return {
    async exportProviders(input) {
      const chosen = (await deps.getProviders()).filter(
        (provider) => !provider.account && input.providerIds.includes(provider.id)
      );
      if (chosen.length === 0) throw new Error('Choose at least one provider to export');
      const file = await deps.pickExportPath('emdash-providers.json');
      if (!file) return { path: null, count: 0 };
      const providers = await Promise.all(
        chosen.map(async (provider) => {
          const apiKey = input.includeKeys ? await deps.keys.read(provider.id) : null;
          return apiKey ? { ...provider, apiKey } : provider;
        })
      );
      const body = { format: PROVIDER_EXPORT_FORMAT, version: 1, providers };
      // A file holding keys is readable by its owner only.
      await writeText(
        file,
        `${JSON.stringify(body, null, 2)}\n`,
        input.includeKeys ? 0o600 : 0o644
      );
      return { path: file, count: providers.length };
    },

    async readImport() {
      const file = await deps.pickImportPath();
      if (!file) return null;
      const parsed = parseProviderExport(await readText(file));
      const existing = new Map(
        (await deps.getProviders()).map((provider) => [provider.id, provider])
      );
      // An official account is never replaced by an API provider of the same id.
      const entries = parsed.entries.filter(({ provider }) => !existing.get(provider.id)?.account);
      const skipped = parsed.skipped + parsed.entries.length - entries.length;
      // A message ending in " import" would trip electron-vite's import scan of the bundle.
      if (entries.length === 0) throw new Error('The file has no providers Emdash can read');
      pending = { token: randomUUID(), entries };
      return {
        token: pending.token,
        skipped,
        providers: entries.map(({ provider, apiKey }) => {
          const current = existing.get(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            description: describeProvider(provider),
            models: provider.models.length,
            hasKey: apiKey !== null,
            exists: current !== undefined,
            previousUrl: current ? changedAddress(current, provider) : null,
          };
        }),
      };
    },

    async importProviders(input) {
      if (!pending || pending.token !== input.token) {
        throw new Error('Choose the file again');
      }
      const chosen = pending.entries.filter(({ provider }) =>
        input.providerIds.includes(provider.id)
      );
      pending = null;
      const current = await deps.getProviders();
      const next = [...current];
      const staleKeys: string[] = [];
      for (const { provider, apiKey } of chosen) {
        const at = next.findIndex((candidate) => candidate.id === provider.id);
        const replaced = at === -1 ? undefined : next[at];
        if (replaced?.account) continue;
        if (at === -1) next.push(provider);
        else next[at] = provider;
        // The saved key must not follow a provider to an address the file chose.
        const keyImported = input.includeKeys && apiKey !== null;
        if (replaced && !keyImported && changedAddress(replaced, provider)) {
          staleKeys.push(provider.id);
        }
      }
      // Cleared before the new addresses are saved: a failure in between loses a key
      // rather than sending it somewhere new.
      for (const id of staleKeys) await deps.keys.clear(id);
      await deps.saveProviders(next);
      if (input.includeKeys) {
        for (const { provider, apiKey } of chosen) {
          if (apiKey) await deps.keys.set(provider.id, apiKey);
        }
      }
      return { imported: chosen.length };
    },
  };
}

/**
 * The address a saved key went to, when `next` sends it elsewhere (another base URL or
 * models URL); null when it stays.
 */
function changedAddress(previous: ModelProvider, next: ModelProvider): string | null {
  const trim = (url: string | undefined) => url?.trim().replace(/\/+$/, '') ?? '';
  if (trim(previous.baseUrl) !== trim(next.baseUrl)) return previous.baseUrl;
  if (trim(previous.modelsUrl) !== trim(next.modelsUrl)) {
    return previous.modelsUrl ?? previous.baseUrl;
  }
  return null;
}

/**
 * Writes a fresh file with `mode` and moves it over the target, so an existing file's
 * looser permissions never apply to the keys, not even for a moment.
 */
async function writeNewFile(file: string, text: string, mode: number): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { mode, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** The importable API providers in an export file, and how many entries were not. */
export function parseProviderExport(text: string): { entries: ImportEntry[]; skipped: number } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('This is not a JSON file');
  }
  const file = exportFileSchema.safeParse(json);
  if (!file.success) throw new Error('This is not an Emdash provider export');
  const entries: ImportEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of file.data.providers) {
    const parsed = exportedProviderSchema.safeParse(raw);
    if (!parsed.success || parsed.data.account || seen.has(parsed.data.id)) {
      skipped += 1;
      continue;
    }
    const { apiKey, ...provider } = parsed.data;
    seen.add(provider.id);
    entries.push({ provider, apiKey: apiKey?.trim() || null });
  }
  return { entries, skipped };
}
