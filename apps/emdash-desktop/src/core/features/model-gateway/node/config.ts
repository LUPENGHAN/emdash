import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Document = { [key: string]: Json };
export type ApiProvider = {
  protocol?: 'anthropic' | 'openai-chat' | 'openai-responses' | 'all';
  endpoints?: Partial<Record<'anthropic' | 'openai-chat' | 'openai-responses', string>>;
  protocolKeys?: Partial<Record<'anthropic' | 'openai-chat' | 'openai-responses', string>>;
  anthropicBaseUrl?: string;
  anthropicAuth?: 'bearer' | 'api-key';
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMap: Record<string, string>;
  contextWindows: Record<string, number>;
  headers: Record<string, string>;
};
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function record(value: Json | undefined): Document {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function defaultConfig(): Document {
  return {
    'config-version': 8,
    'api-keys': { codex: [], 'openai-compatibility': [] },
    access: { 'api-keys': [] },
    oauth: {},
    routing: { retry: { 'request-retry': 0 } },
    server: {},
    observability: {},
  };
}
export function apiProviders(config: Document): ApiProvider[] {
  const keys = record(config['api-keys']);
  const entries: ApiProvider[] = [];
  const add = (raw: Document, key: string, label?: string): void => {
    const url = typeof raw['base-url'] === 'string' ? raw['base-url'].replace(/\/+$/, '') : '';
    if (
      !url ||
      !key ||
      raw.disabled === true ||
      (Array.isArray(raw['excluded-models']) && raw['excluded-models'].includes('*')) ||
      (typeof raw.weight === 'number' && raw.weight <= 0)
    )
      return;
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !['http:', 'https:'].includes(parsed.protocol)
    )
      throw new Error('Provider URL must be HTTP or HTTPS without embedded credentials.');
    const modelMap: Record<string, string> = {};
    const contextWindows: Record<string, number> = {};
    for (const item of Array.isArray(raw.models) ? raw.models : []) {
      const name = typeof item === 'string' ? item : record(item).name;
      const alias = typeof item === 'string' ? item : record(item).alias || name;
      if (typeof name === 'string' && typeof alias === 'string' && name && alias) {
        modelMap[alias] = name;
        const context =
          typeof item === 'object' && item !== null
            ? record(item)['max-context-length']
            : undefined;
        if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0)
          contextWindows[alias] = context;
      }
    }
    const models = Object.keys(modelMap);
    if (!models.length) return;
    const headers = Object.fromEntries(
      Object.entries(record(raw.headers)).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
    entries.push({
      id: 'api:' + digest(url + '\0' + key).slice(0, 24),
      name: label || (typeof raw.name === 'string' ? raw.name : parsed.host),
      baseUrl: url,
      apiKey: key,
      models,
      modelMap,
      contextWindows,
      headers,
    });
  };
  for (const family of ['codex', 'openai-compatibility']) {
    for (const item of Array.isArray(keys[family]) ? keys[family] : []) {
      const group = record(item);
      for (const value of Array.isArray(group.keys) ? group.keys : [group]) {
        const raw = { ...group, ...record(value) };
        const key = raw['api-key'];
        if (typeof key === 'string')
          add(raw, key, typeof group.name === 'string' ? group.name : undefined);
      }
    }
  }
  const seen = new Set<string>();
  return entries.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}
