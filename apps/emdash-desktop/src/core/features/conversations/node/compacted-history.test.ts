import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compactedSegments, readCompactedSegment } from './compacted-history';
import { claudeProjectDirName } from './external-sessions';

const lines = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

const user = (text: string, at: string, extra: object = {}) => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: text },
  ...extra,
});
const assistant = (content: unknown[], at: string) => ({
  type: 'assistant',
  timestamp: at,
  message: { role: 'assistant', model: 'claude-opus-5-5', content },
});
const boundary = (preTokens: number, trigger: string) => ({
  type: 'system',
  subtype: 'compact_boundary',
  parentUuid: null,
  compactMetadata: { trigger, preTokens },
});

describe('compacted history', () => {
  let home: string;
  let cwd: string;
  const env = () => ({ home, env: {} });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'compacted-'));
    cwd = path.join(home, 'repo');
    await mkdir(cwd);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function session(records: unknown[]) {
    const dir = path.join(home, '.claude', 'projects', claudeProjectDirName(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 's1.jsonl'), lines(records));
  }

  it('splits a Claude session at its compactions, leaving out the part the chat shows', async () => {
    await session([
      user('Fix the login bug', 't1'),
      assistant(
        [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
        't2'
      ),
      user('', 't2', { message: { role: 'user', content: [{ type: 'tool_result' }] } }),
      assistant([{ type: 'text', text: 'Fixed.' }], 't3'),
      user('<command-name>/clear</command-name>', 't3'),
      user('side', 't3', { isSidechain: true }),
      boundary(170000, 'auto'),
      user('This session is being continued from a previous conversation…', 't4', {
        isCompactSummary: true,
      }),
      user('Now add tests', 't5'),
      assistant([{ type: 'text', text: 'Added.' }], 't6'),
      boundary(90000, 'manual'),
      user('Summary two', 't7', { isCompactSummary: true }),
      user('What the chat still shows', 't8'),
    ]);

    const segments = await compactedSegments('claude', 's1', cwd, env());
    expect(segments).toEqual([
      {
        index: 0,
        startedAt: 't1',
        endedAt: 't3',
        firstPrompt: 'Fix the login bug',
        turns: 2,
        trigger: 'auto',
        contextTokens: 170000,
      },
      {
        index: 1,
        startedAt: 't5',
        endedAt: 't6',
        firstPrompt: 'Now add tests',
        turns: 2,
        trigger: 'manual',
        contextTokens: 90000,
      },
    ]);

    expect(await readCompactedSegment('claude', 's1', cwd, 0, env())).toEqual({
      turns: [
        { role: 'user', text: 'Fix the login bug' },
        { role: 'assistant', text: 'Looking.\n▸ Bash: npm test\nFixed.' },
      ],
      summary: 'This session is being continued from a previous conversation…',
    });
    expect((await readCompactedSegment('claude', 's1', cwd, 1, env()))?.summary).toBe(
      'Summary two'
    );
    expect(await readCompactedSegment('claude', 's1', cwd, 2, env())).toBeNull();
  });

  it('finds nothing for sessions never compacted, unknown ones, or other agents', async () => {
    await session([user('Hi', 't1'), assistant([{ type: 'text', text: 'Hello' }], 't2')]);
    expect(await compactedSegments('claude', 's1', cwd, env())).toEqual([]);
    expect(await compactedSegments('claude', 'missing', cwd, env())).toEqual([]);
    expect(await compactedSegments('codex', 's1', cwd, env())).toEqual([]);
  });
});
