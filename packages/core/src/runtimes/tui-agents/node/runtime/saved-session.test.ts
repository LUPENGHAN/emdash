import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasSavedSession } from './saved-session';

describe('hasSavedSession', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'saved-session-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('finds a Claude session file in any project folder', async () => {
    const folder = path.join(home, '.claude', 'projects', '-Users-me-repo');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'used.jsonl'), '{}\n');
    expect(await hasSavedSession('claude', 'used', {}, home)).toBe(true);
    expect(await hasSavedSession('claude', 'never-used', {}, home)).toBe(false);
  });

  it('honours CLAUDE_CONFIG_DIR and assumes resumable when it cannot tell', async () => {
    const config = path.join(home, 'custom');
    await mkdir(path.join(config, 'projects', 'p'), { recursive: true });
    await writeFile(path.join(config, 'projects', 'p', 'id.jsonl'), '{}\n');
    expect(await hasSavedSession('claude', 'id', { CLAUDE_CONFIG_DIR: config }, home)).toBe(true);
    expect(await hasSavedSession('claude', 'id', {}, path.join(home, 'missing'))).toBe(true);
    expect(await hasSavedSession('codex', 'anything', {}, home)).toBe(true);
  });
});
