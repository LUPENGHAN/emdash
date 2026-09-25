import { describe, expect, it, vi } from 'vitest';
import { parseCursorMessage, rootMessageIds } from './cursor-sessions';

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
