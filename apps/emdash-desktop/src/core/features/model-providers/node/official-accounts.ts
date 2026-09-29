import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OfficialAccount, OfficialAccountAgent, OfficialAccountStatus } from '../api';

const execFileAsync = promisify(execFile);

type Env = { home: string; env: NodeJS.ProcessEnv };

const defaultEnv = (): Env => ({ home: homedir(), env: process.env });

/** The variable that moves each agent's config (and sign-in) to another directory. */
export const ACCOUNT_HOME_ENV: Record<OfficialAccountAgent, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * What stays with each account: its sign-in. Claude Code keeps its tokens in the
 * keychain under a name derived from the config dir (or `.credentials.json` without
 * one) and which account is signed in, with per-user state, in `.claude.json`; Codex
 * keeps its tokens in `auth.json`.
 */
const ACCOUNT_OWN: Record<OfficialAccountAgent, ReadonlySet<string>> = {
  claude: new Set(['.credentials.json', '.claude.json', '.claude.json.backup']),
  codex: new Set(['auth.json']),
};

/** Where the agent keeps its own config when no account is chosen. */
export function mainAgentHome(agent: OfficialAccountAgent, { home, env }: Env = defaultEnv()) {
  return agent === 'claude'
    ? (env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'))
    : (env.CODEX_HOME ?? path.join(home, '.codex'));
}

/**
 * An account's own config dir. Its path names the account's keychain entry (Claude
 * Code), so it must not move; the account id never changes.
 */
export function accountHome(account: Pick<OfficialAccount, 'id' | 'account'>, env = defaultEnv()) {
  const slug = account.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(env.home, '.emdash', 'accounts', `${account.account.agent}-${slug}`);
}

/**
 * Readies an account's config dir: everything in the agent's own dir except the
 * sign-in is linked in, so sessions (and resuming them on any account), settings,
 * skills, plugins and history stay one set. Claude Code's `.claude.json` starts as a
 * copy of the main one without its signed-in account, keeping MCP servers and project
 * trust. Entries already there are left alone.
 */
export async function prepareAccountHome(
  account: Pick<OfficialAccount, 'id' | 'account'>,
  env: Env = defaultEnv()
): Promise<string> {
  const { agent } = account.account;
  const dir = accountHome(account, env);
  const main = mainAgentHome(agent, env);
  await mkdir(dir, { recursive: true });
  const own = ACCOUNT_OWN[agent];
  let entries: string[] = [];
  try {
    entries = await readdir(main);
  } catch {
    // No main config yet: the account starts empty.
  }
  for (const name of entries) {
    if (own.has(name) || (await exists(path.join(dir, name)))) continue;
    await symlink(path.join(main, name), path.join(dir, name)).catch(() => undefined);
  }
  if (agent === 'claude') await seedClaudeState(dir, env);
  return dir;
}

async function seedClaudeState(dir: string, { home, env }: Env) {
  const target = path.join(dir, '.claude.json');
  if (await exists(target)) return;
  // Without CLAUDE_CONFIG_DIR, Claude Code keeps it next to its config dir (older) or in it.
  const candidates = env.CLAUDE_CONFIG_DIR
    ? [path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')]
    : [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')];
  for (const source of candidates) {
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const key of ['oauthAccount', 'primaryApiKey', 'customApiKeyResponses', 'userID']) {
      delete state[key];
    }
    await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** The account's sign-in, as the agent's own CLI reports it (Codex: from auth.json). */
export async function officialAccountStatus(
  account: Pick<OfficialAccount, 'id' | 'account'>,
  env: Env = defaultEnv()
): Promise<OfficialAccountStatus> {
  const dir = await prepareAccountHome(account, env);
  if (account.account.agent === 'claude') {
    try {
      const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
        env: { ...env.env, PATH: searchPath(env), CLAUDE_CONFIG_DIR: dir },
        timeout: 20_000,
      });
      const status = JSON.parse(stdout) as Record<string, unknown>;
      return {
        signedIn: status.loggedIn === true,
        email: typeof status.email === 'string' ? status.email : null,
        plan: typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
      };
    } catch {
      return { signedIn: false, email: null, plan: null };
    }
  }
  return codexAuthStatus(dir);
}

async function codexAuthStatus(dir: string): Promise<OfficialAccountStatus> {
  let auth: { tokens?: { id_token?: unknown } } | null = null;
  try {
    auth = JSON.parse(await readFile(path.join(dir, 'auth.json'), 'utf8'));
  } catch {
    return { signedIn: false, email: null, plan: null };
  }
  const idToken = auth?.tokens?.id_token;
  if (typeof idToken !== 'string') return { signedIn: Boolean(auth), email: null, plan: null };
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    const openai = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return {
      signedIn: true,
      email: typeof payload.email === 'string' ? payload.email : null,
      plan: typeof openai?.chatgpt_plan_type === 'string' ? openai.chatgpt_plan_type : null,
    };
  } catch {
    return { signedIn: true, email: null, plan: null };
  }
}

function searchPath({ home, env }: Env): string {
  return [env.PATH, path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(':');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Opens a Terminal window running the agent's own sign-in for this account (its
 * browser flow, and any code it asks for, happen there). macOS only; elsewhere the
 * command to run is returned instead.
 */
export async function openOfficialAccountLogin(
  account: Pick<OfficialAccount, 'id' | 'account' | 'name'>,
  env: Env = defaultEnv()
): Promise<{ opened: boolean; command: string }> {
  const { agent } = account.account;
  const dir = await prepareAccountHome(account, env);
  const login = agent === 'claude' ? 'claude auth login' : 'codex login';
  const command = `${ACCOUNT_HOME_ENV[agent]}=${shellQuote(dir)} ${login}`;
  if (process.platform !== 'darwin') return { opened: false, command };
  const script = path.join(dir, 'emdash-sign-in.command');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      `# Written by Emdash: signs in the "${account.name.replace(/\n/g, ' ')}" account.`,
      'clear',
      `echo ${shellQuote(`Signing in: ${account.name}`)}`,
      `export ${ACCOUNT_HOME_ENV[agent]}=${shellQuote(dir)}`,
      login,
      'echo',
      "echo 'Done. You can close this window and return to Emdash.'",
      '',
    ].join('\n')
  );
  await chmod(script, 0o700);
  await execFileAsync('open', ['-a', 'Terminal', script]);
  return { opened: true, command };
}
