import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectDirName } from '../external-sessions';
import {
  handoffSummaryRequest,
  prepareHandoff,
  readHandoffSummary,
  SUMMARY_DONE_MARKER,
  type HandoffDeps,
} from './prepare-handoff';
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

describe('readTranscript for Pi-family sessions', () => {
  it('reads user and assistant text by session id, skipping tool results', async () => {
    const dir = path.join(home, '.omp', 'agent', 'sessions', '-repo');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '2026-09-25T05-16-09Z_omp-7.jsonl'),
      jsonl(
        { type: 'title', v: 1, title: 't' },
        { type: 'session', id: 'omp-7', cwd },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Hi' }] } },
        {
          type: 'message',
          message: { role: 'toolResult', content: [{ type: 'text', text: 'x' }] },
        },
        {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
        }
      )
    );

    expect(await readTranscript('oh-my-pi', 'omp-7', cwd, { home, env: {} })).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ]);
  });

  it('finds a session whose header id differs from its name, or by its recorded path', async () => {
    const dir = path.join(home, '.omp', 'agent', 'sessions', '-repo');
    await mkdir(dir, { recursive: true });
    // A terminal resume rewrote the header with a new id; the name keeps the first one.
    const file = path.join(dir, '2026-09-30T00-36-37Z_first-id.jsonl');
    await writeFile(
      file,
      jsonl(
        { type: 'session', id: 'header-id', cwd },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'test' }] } }
      )
    );
    const turns = [{ role: 'user', text: 'test' }];

    expect(await readTranscript('oh-my-pi', 'header-id', cwd, { home, env: {} })).toEqual(turns);
    expect(await readTranscript('oh-my-pi', file, cwd, { home, env: {} })).toEqual(turns);
    expect(await readTranscript('oh-my-pi', '/etc/other.jsonl', cwd, { home, env: {} })).toEqual(
      []
    );
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

  it('leads with the recent turns when the session moved on from its first ask', async () => {
    const turns = [
      { role: 'user' as const, text: 'Build the export page' },
      { role: 'assistant' as const, text: 'Export page done.' },
      { role: 'user' as const, text: 'Now fix the login bug' },
      { role: 'assistant' as const, text: 'Login fixed.' },
      { role: 'user' as const, text: 'Add tests for the importer' },
      { role: 'assistant' as const, text: 'x'.repeat(2000) },
      { role: 'user' as const, text: 'Then migrate the importer to streams' },
      { role: 'assistant' as const, text: 'Streams: reader done, writer left.' },
      { role: 'user' as const, text: 'continue' },
      { role: 'assistant' as const, text: 'Writer half done, tests failing on EOF.' },
    ];
    const { prompt } = await prepareHandoff(
      { providerId: 'claude', sessionId: 's1', cwd },
      deps({ readTranscript: vi.fn(async () => turns) })
    );
    const recent = prompt.indexOf('## 最近的对话');
    const first = prompt.indexOf('## 最初的需求（仅作背景');
    expect(recent).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(recent);
    // The last four asks, in order, with the latest reply in full.
    const order = [
      'Now fix the login bug',
      'Add tests for the importer',
      'Then migrate',
      'continue',
    ];
    const at = order.map((text) => prompt.indexOf(text, recent));
    expect(at.every((index, i) => index > recent && (i === 0 || index > at[i - 1]!))).toBe(true);
    expect(prompt).toContain('Writer half done, tests failing on EOF.');
    // Earlier replies are only a line of context.
    expect(prompt).not.toContain('x'.repeat(500));
    expect(prompt.slice(first)).toContain('Build the export page');
  });

  it("asks for a summary file and leads with it, and the user's note, once it is done", async () => {
    const { summaryPath, prompt: ask } = await handoffSummaryRequest(cwd, deps());
    expect(summaryPath).toBe('.emdash/handoffs/2026-09-25T10-20-30-summary.md');
    expect(ask).toContain(summaryPath);
    expect(ask).toContain('## 当前目标');
    expect(ask).toContain(SUMMARY_DONE_MARKER);

    // Half written: not taken yet.
    await writeFile(path.join(cwd, summaryPath), '# 交接总结\n\n## 当前目标\n迁移 importer');
    expect(await readHandoffSummary(cwd, summaryPath)).toBeNull();
    await writeFile(
      path.join(cwd, summaryPath),
      `# 交接总结\n\n## 当前目标\n迁移 importer 到 streams\n\n${SUMMARY_DONE_MARKER}\n`
    );
    expect(await readHandoffSummary(cwd, summaryPath)).toContain('迁移 importer 到 streams');

    const { prompt } = await prepareHandoff(
      { providerId: 'claude', sessionId: 's1', cwd },
      deps(),
      {
        summaryPath,
        note: 'Only the writer is left',
      }
    );
    const note = prompt.indexOf('## 用户的说明');
    const summary = prompt.indexOf('## Claude Code 写的交接总结');
    const recent = prompt.indexOf('## 最近的对话（用来核对总结）');
    expect(note).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(note);
    expect(recent).toBeGreaterThan(summary);
    expect(prompt).toContain('迁移 importer 到 streams');
    expect(prompt).not.toContain(SUMMARY_DONE_MARKER);
  });

  it('never reads a summary path outside the handoff folder', async () => {
    await writeFile(path.join(cwd, 'secret.md'), `x\n${SUMMARY_DONE_MARKER}`);
    expect(await readHandoffSummary(cwd, 'secret.md')).toBeNull();
    expect(await readHandoffSummary(cwd, '.emdash/handoffs/../../secret-summary.md')).toBeNull();
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
