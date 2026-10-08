import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cursorSessionDir,
  parseCursorMessage,
  placeCursorSession,
  rootMessageIds,
} from './cursor-sessions';

vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('rootMessageIds', () => {
  it('reads the repeated 32-byte ids of field 1 and skips other fields', () => {
    const a = Buffer.alloc(32, 0xab);
    const b = Buffer.alloc(32, 0x01);
    const root = Buffer.concat([
      Buffer.from([0x0a, 0x20]),
      a,
      Buffer.from([0x12, 0x03]),
      Buffer.from('abc'), // field 2 (not a message id)
      Buffer.from([0x18, 0x96, 0x01]), // field 3 varint
      Buffer.from([0x0a, 0x20]),
      b,
    ]);
    expect(rootMessageIds(root)).toEqual([a.toString('hex'), b.toString('hex')]);
  });
});

describe('parseCursorMessage', () => {
  it("keeps just the user's ask from the injected wrapper", () => {
    const content =
      '<user_info>\nOS Version: darwin\n</user_info>\n<user_query>\nFix the sync bug\n</user_query>';
    expect(parseCursorMessage(json({ role: 'user', content }))).toEqual({
      role: 'user',
      text: 'Fix the sync bug',
    });
  });

  it('keeps plain user text and assistant text parts, drops system and injected turns', () => {
    expect(parseCursorMessage(json({ role: 'user', content: 'hello' }))).toEqual({
      role: 'user',
      text: 'hello',
    });
    expect(
      parseCursorMessage(
        json({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }, { type: 'tool' }] })
      )
    ).toEqual({ role: 'assistant', text: 'Done.' });
    expect(parseCursorMessage(json({ role: 'system', content: 'You are…' }))).toBeNull();
    expect(parseCursorMessage(json({ role: 'user', content: '<rules>only</rules>' }))).toBeNull();
    expect(parseCursorMessage(Buffer.from([0x0a, 0x20]))).toBeNull();
  });
});

describe('placeCursorSession', () => {
  const id = '5c9a5f15-9b4c-4aa9-8869-bee2629dee8f';
  const cwd = '/work/repo';
  let home: string;
  let root: string;
  const env = () => ({ home, env: {} });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'cursor-place-'));
    root = path.join(home, '.cursor');
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function session(dir: string, meta: object, store: string, mtimeSec?: number) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    await writeFile(path.join(dir, 'store.db'), store);
    await writeFile(path.join(dir, 'store.db-wal'), `${store}-wal`);
    if (mtimeSec !== undefined) {
      for (const name of ['meta.json', 'store.db', 'store.db-wal']) {
        await utimes(path.join(dir, name), mtimeSec, mtimeSec);
      }
    }
  }

  it('copies a terminal session into the chat store, with chat meta', async () => {
    const terminal = cursorSessionDir(root, id, cwd, 'pty');
    await session(terminal, { schemaVersion: 1, hasConversation: true, title: 'Fix', cwd }, 'T');
    expect(await placeCursorSession(env(), id, cwd, 'acp')).toBe(true);
    const chat = path.join(root, 'acp-sessions', id);
    expect(await readFile(path.join(chat, 'store.db'), 'utf8')).toBe('T');
    expect(await readFile(path.join(chat, 'store.db-wal'), 'utf8')).toBe('T-wal');
    expect(JSON.parse(await readFile(path.join(chat, 'meta.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      cwd,
      title: 'Fix',
    });
  });

  it('copies a chat session under the hash of the cwd, replacing an older copy', async () => {
    const terminal = cursorSessionDir(root, id, cwd, 'pty');
    await session(terminal, { schemaVersion: 1, hasConversation: true, cwd }, 'old', 1_000);
    await session(path.join(root, 'acp-sessions', id), { schemaVersion: 1, cwd }, 'new', 2_000);
    expect(await placeCursorSession(env(), id, cwd, 'pty')).toBe(true);
    expect(await readFile(path.join(terminal, 'store.db'), 'utf8')).toBe('new');
    const meta = JSON.parse(await readFile(path.join(terminal, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ schemaVersion: 1, hasConversation: true, cwd });
  });

  it('leaves the latest copy where it is', async () => {
    const chat = path.join(root, 'acp-sessions', id);
    await session(chat, { schemaVersion: 1, cwd }, 'new', 2_000);
    await session(cursorSessionDir(root, id, cwd, 'pty'), { hasConversation: true }, 'old', 1_000);
    expect(await placeCursorSession(env(), id, cwd, 'acp')).toBe(true);
    expect(await readFile(path.join(chat, 'store.db'), 'utf8')).toBe('new');
  });

  it('has nothing to resume for a missing, empty or unsafe session id', async () => {
    expect(await placeCursorSession(env(), id, cwd, 'acp')).toBe(false);
    await session(cursorSessionDir(root, id, cwd, 'pty'), { hasConversation: false }, 'T');
    expect(await placeCursorSession(env(), id, cwd, 'acp')).toBe(false);
    expect(await placeCursorSession(env(), '../x', cwd, 'acp')).toBe(false);
  });
});
