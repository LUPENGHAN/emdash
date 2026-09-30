import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piFamilySessionId } from './delete-agent-session';

describe('piFamilySessionId', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pi-session-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a terminal session's id from its file, whose name may carry another", async () => {
    const file = path.join(dir, '2026-09-30T00-36-37-092Z_01a0efbd.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'title', v: 1, title: '' }),
        JSON.stringify({ type: 'session', version: 3, id: '01a0efbe', cwd: '/w' }),
      ].join('\n') + '\n'
    );
    expect(await piFamilySessionId('oh-my-pi', file)).toBe('01a0efbe');
    expect(await piFamilySessionId('pi', file)).toBe('01a0efbe');
  });

  it('keeps ids, other agents, and unreadable paths as stored', async () => {
    expect(await piFamilySessionId('oh-my-pi', '01a0efbe')).toBe('01a0efbe');
    expect(await piFamilySessionId('codex', '/x/y.jsonl')).toBe('/x/y.jsonl');
    const missing = path.join(dir, 'gone.jsonl');
    expect(await piFamilySessionId('oh-my-pi', missing)).toBe(missing);
    expect(await piFamilySessionId('oh-my-pi', null)).toBeNull();
  });
});
