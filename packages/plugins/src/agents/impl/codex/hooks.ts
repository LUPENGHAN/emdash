import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import type {
  CanonicalHookEvent,
  HookRegistration,
} from '@emdash/core/services/agent-plugins/api/plugins';
import {
  EMDASH_MARKER,
  buildNestedEntry,
  configRoots,
  defaultHookEventParser,
  envConfigRoot,
  filterUserHooks,
  hookMapFromConfig,
  makeHookPostCommand,
  makeNotificationHookCommand,
  readJsonConfig,
  readTomlConfig,
  writeJsonConfig,
  writeTomlConfig,
} from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import * as toml from 'smol-toml';

export const CODEX_CONFIG_PATH = 'config.toml';
export const CODEX_LEGACY_HOOKS_PATH = 'hooks.json';

const LEGACY_CODEX_NOTIFY_COMMAND = [
  'bash',
  '-c',
  'curl -sf -X POST ' +
    "-H 'Content-Type: application/json' " +
    '-H "X-Emdash-Token: $EMDASH_HOOK_NONCE" ' +
    '-H "X-Emdash-Pty-Id: $EMDASH_PTY_ID" ' +
    '-H "X-Emdash-Event-Type: notification" ' +
    '-d "$1" ' +
    '"http://127.0.0.1:$EMDASH_HOOK_PORT/hook" || true',
  '_',
];

function isLegacyCodexNotify(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (JSON.stringify(value) === JSON.stringify(LEGACY_CODEX_NOTIFY_COMMAND)) return true;
  const [command, noProfile, fileFlag, scriptPath] = value.map((item) => String(item));
  return (
    command.toLowerCase() === 'powershell.exe' &&
    noProfile === '-NoProfile' &&
    fileFlag === '-File' &&
    typeof scriptPath === 'string' &&
    scriptPath.endsWith('emdash-codex-notify.ps1')
  );
}

async function removeLegacyCodexNotify(fs: PluginFs): Promise<void> {
  const raw = await fs.read(CODEX_CONFIG_PATH);
  if (!raw) return;

  let config: Record<string, unknown>;
  try {
    config = toml.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (!isLegacyCodexNotify(config.notify)) return;

  delete config.notify;
  await fs.write(CODEX_CONFIG_PATH, toml.stringify(config));
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHooks(
  config: Record<string, unknown>,
  configPath: string
): Record<string, Record<string, unknown>[]> {
  if (configPath !== CODEX_CONFIG_PATH) return hookMapFromConfig(config, configPath);

  const hooks = config.hooks;
  if (hooks === undefined) return {};
  if (!isConfigObject(hooks)) {
    throw new Error(`Invalid ${configPath}: expected "hooks" to be an object`);
  }

  // Codex owns this map and updates it as hook definitions are reviewed or disabled.
  // It shares the `hooks` table with event arrays but is not itself an event.
  const { state, ...eventHooks } = hooks;
  if (state !== undefined && !isConfigObject(state)) {
    throw new Error(`Invalid ${configPath}: expected "hooks.state" to be an object`);
  }

  return hookMapFromConfig({ hooks: eventHooks }, configPath);
}

function configWithEventHooks(
  config: Record<string, unknown>,
  eventHooks: Record<string, Record<string, unknown>[]>
): Record<string, unknown> {
  const existingHooks = isConfigObject(config.hooks) ? config.hooks : {};
  return { ...config, hooks: { ...existingHooks, ...eventHooks } };
}

function hasCodexEmdashHooks(hooks: Record<string, unknown[]>, specs: [string, string][]): boolean {
  return specs.every(([key, command]) => {
    const entries = Array.isArray(hooks[key]) ? hooks[key] : [];
    return entries.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(buildNestedEntry(command))
    );
  });
}

/** Codex's `hooks.state` key segment for an event: `SessionStart` → `session_start`. */
function codexEventKey(event: string): string {
  return event.replace(/(?<=[a-z])(?=[A-Z])/g, '_').toLowerCase();
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isConfigObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])])
  );
}

/**
 * The hash Codex records when a hook is reviewed (codex-rs hooks `hook_hash`): SHA-256
 * of the canonical JSON of the event name and the hook group, its handler normalized
 * (default 600s timeout, not async).
 */
export function codexHookHash(event: string, group: Record<string, unknown>): string {
  const [handler = {}] = Array.isArray(group.hooks)
    ? (group.hooks as Record<string, unknown>[])
    : [];
  const identity = {
    event_name: codexEventKey(event),
    ...(typeof group.matcher === 'string' && { matcher: group.matcher }),
    hooks: [
      {
        type: 'command',
        command: handler.command,
        timeout: typeof handler.timeout === 'number' ? handler.timeout : 600,
        async: handler.async === true,
        ...(typeof handler.statusMessage === 'string' && { statusMessage: handler.statusMessage }),
      },
    ],
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalJson(identity)))
    .digest('hex');
  return `sha256:${digest}`;
}

function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The `hooks.state` entries that mark Emdash's hook groups as reviewed, by key. */
function emdashHookTrust(
  hooks: Record<string, unknown[]>,
  specs: [string, string][],
  root: string
): Map<string, string> {
  // Codex keys the review by its config file's canonical path (/tmp → /private/tmp).
  const configFile = path.join(canonicalPath(root), CODEX_CONFIG_PATH);
  const trust = new Map<string, string>();
  for (const [event, command] of specs) {
    const expected = JSON.stringify(buildNestedEntry(command));
    (Array.isArray(hooks[event]) ? hooks[event] : []).forEach((entry, groupIndex) => {
      if (JSON.stringify(entry) !== expected) return;
      const key = `${configFile}:${codexEventKey(event)}:${groupIndex}:0`;
      trust.set(key, codexHookHash(event, entry as Record<string, unknown>));
    });
  }
  return trust;
}

function hookState(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = isConfigObject(config.hooks) ? config.hooks : {};
  return isConfigObject(hooks.state) ? hooks.state : {};
}

/**
 * Codex runs a hook only after the user reviews it ("Hooks need review"); until then
 * Emdash cannot tell which session a terminal holds, so it could not resume it. Emdash
 * marks its own hooks reviewed as it writes them; an edited hook no longer matches its
 * hash and is reviewed again. Without a local root (a remote config) nothing is added.
 */
function withEmdashHooksTrusted(
  config: Record<string, unknown>,
  hooks: Record<string, unknown[]>,
  specs: [string, string][],
  root: string | undefined
): Record<string, unknown> {
  if (!root) return config;
  const state = { ...hookState(config) };
  for (const [key, hash] of emdashHookTrust(hooks, specs, root)) {
    const current = isConfigObject(state[key]) ? state[key] : {};
    state[key] = { ...current, trusted_hash: hash };
  }
  return { ...config, hooks: { ...(config.hooks as Record<string, unknown>), state } };
}

function emdashHooksTrusted(
  config: Record<string, unknown>,
  hooks: Record<string, unknown[]>,
  specs: [string, string][],
  root: string | undefined
): boolean {
  if (!root) return true;
  const state = hookState(config);
  return [...emdashHookTrust(hooks, specs, root)].every(([key, hash]) => {
    const entry = state[key];
    return isConfigObject(entry) && entry.trusted_hash === hash;
  });
}

async function readLegacyHooks(fs: PluginFs): Promise<Record<string, unknown[]>> {
  const config = await readJsonConfig(fs, CODEX_LEGACY_HOOKS_PATH);
  return getHooks(config, CODEX_LEGACY_HOOKS_PATH);
}

async function migrateLegacyHooks(
  fs: PluginFs,
  hooks: Record<string, unknown[]>
): Promise<() => Promise<void>> {
  const legacyHooks = await readLegacyHooks(fs);

  for (const [key, entries] of Object.entries(legacyHooks)) {
    if (!Array.isArray(entries)) continue;

    const userEntries = filterUserHooks(entries);
    if (!userEntries.length) continue;

    const existing = Array.isArray(hooks[key]) ? hooks[key] : [];
    hooks[key] = [...filterUserHooks(existing), ...userEntries];
  }

  return async () => {
    await fs.delete(CODEX_LEGACY_HOOKS_PATH).catch(() => {});
  };
}

function makeCodexSessionStartCommand(): string {
  const post = makeHookPostCommand('session-start', 'stdin', {});
  if (process.platform === 'win32') return post;
  return `INPUT="\${1:-$(cat)}"; printf '%s' "$INPUT" | { ${post}; }`;
}

/**
 * Codex sends `{ type: 'agent-turn-complete' }` as its stop signal instead
 * of a plain 'stop' event type, and uses fixed `notification_type` values
 * in its hook payloads rather than piping JSON.
 */
function parseCodexHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'session-start') {
    const candidates = [body.session_id, body.resource_id, body.resourceId, body.sessionId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return { kind: 'session', providerSessionId: candidate.trim() };
      }
    }
    return { kind: 'ignore' };
  }

  if (eventType === 'notification') {
    const nt = body.notification_type;
    if (nt === 'idle_prompt' || (typeof nt !== 'string' && body.type === 'agent-turn-complete')) {
      return { kind: 'status', type: 'stop' };
    }
    if (nt === 'permission_prompt') {
      return { kind: 'status', type: 'notification', notificationType: 'permission_prompt' };
    }
  }

  return defaultHookEventParser(eventType, body);
}

export function buildCodexHookConfig() {
  const stopCmd = makeNotificationHookCommand('idle_prompt');
  const permCmd = makeNotificationHookCommand('permission_prompt');
  const sessionCmd = makeCodexSessionStartCommand();
  const specs: [string, string][] = [
    ['Stop', stopCmd],
    ['PermissionRequest', permCmd],
    ['SessionStart', sessionCmd],
  ];

  return {
    resolveConfigRoots: configRoots(envConfigRoot('CODEX_HOME', '.codex')),
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readTomlConfig(fs, CODEX_CONFIG_PATH);
      if (hasCodexEmdashHooks(getHooks(config, CODEX_CONFIG_PATH), specs)) {
        return [{ event: 'emdash', command: EMDASH_MARKER }];
      }

      return hasCodexEmdashHooks(await readLegacyHooks(fs), specs)
        ? [{ event: 'emdash', command: EMDASH_MARKER }]
        : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readTomlConfig(fs, CODEX_CONFIG_PATH);
      const hooks = getHooks(config, CODEX_CONFIG_PATH);
      const cleanupLegacy = await migrateLegacyHooks(fs, hooks);

      for (const [key, cmd] of specs) {
        const existing = Array.isArray(hooks[key]) ? hooks[key] : [];
        hooks[key] = [...filterUserHooks(existing), buildNestedEntry(cmd)];
      }
      await writeTomlConfig(
        fs,
        CODEX_CONFIG_PATH,
        withEmdashHooksTrusted(configWithEventHooks(config, hooks), hooks, specs, fs.root)
      );
      await cleanupLegacy();
      await removeLegacyCodexNotify(fs).catch(() => {});
      return [CODEX_CONFIG_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readTomlConfig(fs, CODEX_CONFIG_PATH);
      const hooks = getHooks(config, CODEX_CONFIG_PATH);
      for (const key of Object.keys(hooks)) {
        hooks[key] = filterUserHooks(hooks[key]);
      }
      await writeTomlConfig(fs, CODEX_CONFIG_PATH, configWithEventHooks(config, hooks));

      const legacyConfig = await readJsonConfig(fs, CODEX_LEGACY_HOOKS_PATH);
      const legacyHooks = getHooks(legacyConfig, CODEX_LEGACY_HOOKS_PATH);
      for (const key of Object.keys(legacyHooks)) {
        legacyHooks[key] = filterUserHooks(legacyHooks[key]);
      }
      if (Object.values(legacyHooks).some((entries) => Array.isArray(entries) && entries.length)) {
        await writeJsonConfig(fs, CODEX_LEGACY_HOOKS_PATH, { ...legacyConfig, hooks: legacyHooks });
      } else {
        await fs.delete(CODEX_LEGACY_HOOKS_PATH).catch(() => {});
      }
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readTomlConfig(fs, CODEX_CONFIG_PATH);
      const hooks = getHooks(config, CODEX_CONFIG_PATH);
      // Installed but never reviewed (hooks written by an older Emdash) counts as not
      // installed, so the next install adds the review.
      return hasCodexEmdashHooks(hooks, specs) && emdashHooksTrusted(config, hooks, specs, fs.root);
    },
    parseHookEvent: parseCodexHookEvent,
  };
}
