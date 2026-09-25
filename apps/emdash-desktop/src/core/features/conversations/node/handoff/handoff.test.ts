import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectDirName } from '../external-sessions';
import { prepareHandoff, type HandoffDeps } from './prepare-handoff';
import { readTranscript } from './transcript';

vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'emdash-handoff-')));
  cwd = path.join(home, 'repo');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('readTranscript', () => {
  it('keeps only spoken Claude turns and joins streamed reply chunks', async () => {
    const dir = path.join(home, '.claude', 'projects', claudeProjectDirName(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 's1.jsonl'),
      jsonl(
        { type: 'user', message: { content: '<command-name>/model</command-name>' } },
        { type: 'user', message: { content: 'Add login' } },
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading files.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
        { type: 'user', isSidechain: true, message: { content: 'sub-agent chatter' } }
      )
    );

    const turns = await readTranscript('claude', 's1', cwd, { home, env: {} });

    expect(turns).toEqual([
      { role: 'user', text: 'Add login' },
      { role: 'assistant', text: 'Reading files.\n\nDone.' },
    ]);
  });

  it('reads a Codex rollout by session id', async () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '25');
    await mkdir(dir, { recursive: true });
    const item = (type: string, text: string) => ({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type, content: [{ type: 'text', text }] } },
    });
    await writeFile(
      path.join(dir, 'rollout-2026-09-25T10-00-00-thread-9.jsonl'),
      jsonl(
        { type: 'session_meta', payload: { id: 'thread-9', cwd } },
        item('UserMessage', 'Fix the parser'),
        item('Reasoning', 'ignored'),
        item('AgentMessage', 'Fixed it.')
      )
    );

    expect(await readTranscript('codex', 'thread-9', cwd, { home, env: {} })).toEqual([
      { role: 'user', text: 'Fix the parser' },
      { role: 'assistant', text: 'Fixed it.' },
    ]);
    expect(await readTranscript('codex', 'missing', cwd, { home, env: {} })).toEqual([]);
  });
});

describe('prepareHandoff', () => {
  function deps(overrides: Partial<HandoffDeps> = {}): HandoffDeps {
    return {
      readTranscript: vi.fn(async () => [
        { role: 'user' as const, text: 'Build the export page' },
        { role: 'assistant' as const, text: 'Half done: API is in, UI remains.' },
      ]),
      git: vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === 'rev-parse') return '.git/info/exclude';
        if (args[0] === 'status') return ' M src/export.ts';
        if (args[0] === 'diff') return ' src/export.ts | 12 +++';
        return 'abc123 Add export API';
      }),
      now: () => new Date('2026-09-25T10:20:30Z'),
      ...overrides,
    };
  }

  it('writes the transcript to the workspace and keeps the first message short', async () => {
    const result = await prepareHandoff({ providerId: 'claude', sessionId: 's1', cwd }, deps());

    expect(result.transcriptPath).toBe('.emdash/handoffs/2026-09-25T10-20-30-claude.md');
    const transcript = await readFile(path.join(cwd, result.transcriptPath!), 'utf8');
    expect(transcript).toContain('## 用户\n\nBuild the export page');
    expect(transcript).toContain('## Claude Code\n\nHalf done');

    expect(result.prompt).toContain('Claude Code');
    expect(result.prompt).toContain('Build the export page');
    expect(result.prompt).toContain('Half done: API is in, UI remains.');
    expect(result.prompt).toContain(' M src/export.ts');
    expect(result.prompt).toContain(result.transcriptPath!);
  });

  it('adds the handoff directory to the local git exclude file once', async () => {
    await mkdir(path.join(cwd, '.git', 'info'), { recursive: true });
    await writeFile(path.join(cwd, '.git', 'info', 'exclude'), '# local\n.idea/');

    await prepareHandoff({ providerId: 'claude', sessionId: 's1', cwd }, deps());
    await prepareHandoff(
      { providerId: 'claude', sessionId: 's1', cwd },
      deps({ now: () => new Date('2026-09-25T11:00:00Z') })
    );

    expect(await readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '# local\n.idea/\n/.emdash/handoffs/\n'
    );
  });

  it('still hands off the git state when the session has no readable turns', async () => {
    const result = await prepareHandoff(
      { providerId: 'codex', sessionId: null, cwd },
      deps({ readTranscript: vi.fn(async () => []) })
    );

    expect(result.transcriptPath).toBeNull();
    expect(result.prompt).toContain('原会话没有可读取的对话记录');
    expect(result.prompt).toContain('abc123 Add export API');
  });
});
