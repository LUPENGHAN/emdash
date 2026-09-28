import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { OwnSource } from '../api';

export type OwnSourceEnv = { home: string; env: NodeJS.ProcessEnv };

/**
 * Where an agent running on its own configuration (no Emdash provider) gets its model,
 * read from that agent's config: `official` when it signs in to its vendor, else the
 * third-party provider the config names. `modelId` is a model the conversation picked
 * (e.g. OpenCode's `provider/model`); without one the config's default model counts.
 * Null when the agent's config cannot be read or names nothing.
 */
export async function describeOwnSource(
  agentId: string,
  modelId: string | undefined,
  env: OwnSourceEnv = { home: homedir(), env: process.env }
): Promise<OwnSource | null> {
  switch (agentId) {
    case 'claude':
      return claudeSource(modelId, env);
    case 'codex':
      return codexSource(modelId, env);
    case 'cursor':
      return { official: true, provider: null, model: modelId ?? null };
    case 'opencode':
      return openCodeSource(modelId, env);
    case 'pi':
      return piSource(modelId, env);
    case 'oh-my-pi':
      return ohMyPiSource(modelId, env);
    default:
      return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `provider/model` → both halves; the model may itself contain slashes. */
function splitModelId(id: string | null): { provider: string | null; model: string | null } {
  if (!id) return { provider: null, model: null };
  const slash = id.indexOf('/');
  return slash > 0
    ? { provider: id.slice(0, slash), model: id.slice(slash + 1) }
    : { provider: null, model: id };
}

/** A base URL counts as the vendor's own when it is on one of its hosts. */
function isVendorUrl(url: string | null, hosts: string[]): boolean {
  if (!url) return true;
  try {
    const host = new URL(url).hostname;
    return hosts.some((vendor) => host === vendor || host.endsWith(`.${vendor}`));
  } catch {
    return false;
  }
}

function hostName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function claudeSource(modelId: string | undefined, { home, env }: OwnSourceEnv) {
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  let baseUrl = str(env.ANTHROPIC_BASE_URL);
  let model = str(env.ANTHROPIC_MODEL);
  const raw = await readText(path.join(configDir, 'settings.json'));
  const settings = raw ? (parseJsonc(raw) as unknown) : null;
  if (isObject(settings)) {
    const settingsEnv = isObject(settings.env) ? settings.env : {};
    baseUrl = str(settingsEnv.ANTHROPIC_BASE_URL) ?? baseUrl;
    model = str(settingsEnv.ANTHROPIC_MODEL) ?? str(settings.model) ?? model;
  }
  const official = isVendorUrl(baseUrl, ['anthropic.com']);
  return {
    official,
    provider: official ? null : hostName(baseUrl!),
    model: modelId ?? model,
  };
}

async function codexSource(modelId: string | undefined, { home, env }: OwnSourceEnv) {
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
  const raw = await readText(path.join(codexHome, 'config.toml'));
  let config: Record<string, unknown> = {};
  try {
    config = raw ? (parseToml(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  const model = modelId ?? str(config.model);
  const providerId = str(config.model_provider) ?? 'openai';
  const providers = isObject(config.model_providers) ? config.model_providers : {};
  const provider = isObject(providers[providerId]) ? providers[providerId] : null;
  const baseUrl = provider ? str(provider.base_url) : null;
  // A custom entry without its own base URL (as cc-switch writes) still reaches OpenAI.
  const official =
    providerId === 'openai' ||
    (provider !== null && isVendorUrl(baseUrl, ['openai.com', 'chatgpt.com']));
  if (official) return { official: true, provider: null, model };
  return { official: false, provider: str(provider?.name) ?? providerId, model };
}

async function openCodeSource(modelId: string | undefined, { home, env }: OwnSourceEnv) {
  const configDir =
    env.OPENCODE_CONFIG_DIR ??
    path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode');
  let config: Record<string, unknown> = {};
  for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) {
    const raw = await readText(path.join(configDir, name));
    const parsed = raw ? (parseJsonc(raw) as unknown) : null;
    if (isObject(parsed)) {
      config = parsed;
      break;
    }
  }
  const { provider: providerId, model } = splitModelId(modelId ?? str(config.model));
  if (!providerId) return model ? { official: false, provider: null, model } : null;
  const providers = isObject(config.provider) ? config.provider : {};
  const entry = isObject(providers[providerId]) ? providers[providerId] : {};
  return { official: false, provider: str(entry.name) ?? providerId, model };
}

async function piSource(modelId: string | undefined, { home, env }: OwnSourceEnv) {
  const dir = env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent');
  const raw = await readText(path.join(dir, 'settings.json'));
  const settings = raw ? (parseJsonc(raw) as unknown) : null;
  const picked = splitModelId(modelId ?? null);
  const provider = picked.provider ?? (isObject(settings) ? str(settings.defaultProvider) : null);
  const model = picked.model ?? (isObject(settings) ? str(settings.defaultModel) : null);
  return provider || model ? { official: false, provider, model } : null;
}

async function ohMyPiSource(modelId: string | undefined, { home }: OwnSourceEnv) {
  const raw = await readText(path.join(home, '.omp', 'agent', 'config.yml'));
  let config: unknown = null;
  try {
    config = raw ? parseYaml(raw) : null;
  } catch {
    config = null;
  }
  const roles = isObject(config) && isObject(config.modelRoles) ? config.modelRoles : {};
  // Role values may carry a thinking level: `zenmux/deepseek/deepseek-v4.1-flash:max`.
  const id = (modelId ?? str(roles.default))?.replace(/:[a-z]+$/, '') ?? null;
  const { provider, model } = splitModelId(id);
  return provider || model ? { official: false, provider, model } : null;
}
