import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourcesForAgent, providerSupportsAgent, type ModelProvider } from '../api';
import { accountHome, officialAccountStatus, prepareAccountHome } from './official-accounts';

describe('official accounts', () => {
  let home: string;
  const env = () => ({ home, env: {} });
  const claudeAccount = { id: 'Work 1', account: { agent: 'claude' as const } };
  const codexAccount = { id: 'alt', account: { agent: 'codex' as const } };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'emdash-accounts-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('keeps each account in a stable dir of its own', () => {
    expect(accountHome(claudeAccount, env())).toBe(
      path.join(home, '.emdash', 'accounts', 'claude-work-1')
    );
  });

  it('links everything but the sign-in into a Claude account, and seeds its state', async () => {
    const main = path.join(home, '.claude');
    await mkdir(path.join(main, 'projects'), { recursive: true });
    await writeFile(path.join(main, 'settings.json'), '{}');
    await writeFile(path.join(main, '.credentials.json'), '{"secret":1}');
    await writeFile(
      path.join(main, '.claude.json'),
      JSON.stringify({ mcpServers: { a: {} }, oauthAccount: { emailAddress: 'me@x' } })
    );

    const dir = await prepareAccountHome(claudeAccount, env());

    expect(await readlink(path.join(dir, 'projects'))).toBe(path.join(main, 'projects'));
    expect(await readlink(path.join(dir, 'settings.json'))).toBe(path.join(main, 'settings.json'));
    await expect(lstat(path.join(dir, '.credentials.json'))).rejects.toThrow();
    const state = JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8'));
    expect(state).toEqual({ mcpServers: { a: {} } });

    // Entries the account already has are left alone.
    await writeFile(path.join(main, 'CLAUDE.md'), '# mine');
    await prepareAccountHome(claudeAccount, env());
    expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(main, 'CLAUDE.md'));
  });

  it("keeps Codex's auth.json per account and reads who signed in", async () => {
    const main = path.join(home, '.codex');
    await mkdir(path.join(main, 'sessions'), { recursive: true });
    await writeFile(path.join(main, 'auth.json'), '{}');
    const dir = await prepareAccountHome(codexAccount, env());
    expect(await readlink(path.join(dir, 'sessions'))).toBe(path.join(main, 'sessions'));
    await expect(lstat(path.join(dir, 'auth.json'))).rejects.toThrow();
    expect(await officialAccountStatus(codexAccount, env())).toEqual({
      signedIn: false,
      email: null,
      plan: null,
    });

    const claims = { email: 'alt@x', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } };
    const token = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    await writeFile(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: token } }));
    expect(await officialAccountStatus(codexAccount, env())).toEqual({
      signedIn: true,
      email: 'alt@x',
      plan: 'pro',
    });
  });

  it('offers an account only to its own agent', () => {
    const api: ModelProvider = { id: 'p', name: 'P', baseUrl: 'http://h', models: [] };
    const account: ModelProvider = { ...api, id: 'a', baseUrl: '', account: { agent: 'codex' } };
    expect(sourcesForAgent([api, account], 'claude')).toEqual([api]);
    expect(sourcesForAgent([api, account], 'codex')).toEqual([api, account]);
    expect(providerSupportsAgent(account, 'codex')).toEqual({ ok: true });
  });
});
