import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectDirName } from './external-sessions';
import { listSubagents, readSubagentTranscript } from './subagents';

const lines = (records: unknown[]) =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

describe('subagents', () => {
  let home: string;
  const env = () => ({ home, env: {} });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'subagents-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function file(relative: string, content: string) {
    const full = path.join(home, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    return full;
  }

  it("lists Claude's Task agents with what they were asked, running or done", async () => {
    const cwd = path.join(home, 'repo');
    await mkdir(cwd);
    const dir = `.claude/projects/${claudeProjectDirName(cwd)}/session-1/subagents`;
    await file(
      `${dir}/agent-a.meta.json`,
      JSON.stringify({ agentType: 'Explore', description: 'Map the frontend' })
    );
    await file(
      `${dir}/agent-a.jsonl`,
      lines([
        {
          type: 'user',
          isSidechain: true,
          timestamp: '2026-09-29T01:00:00.000Z',
          message: { role: 'user', content: 'Look at src/' },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'It is a React app.' }],
          },
        },
      ])
    );
    await file(
      `${dir}/agent-b.meta.json`,
      JSON.stringify({ agentType: 'general-purpose', description: 'Fix the tests' })
    );
    await file(
      `${dir}/agent-b.jsonl`,
      lines([
        {
          type: 'user',
          isSidechain: true,
          timestamp: '2026-09-29T02:00:00.000Z',
          message: { role: 'user', content: 'Fix them' },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', name: 'Bash', input: {} }],
          },
        },
      ])
    );

    const subagents = await listSubagents('claude', 'session-1', cwd, env());
    expect(subagents).toEqual([
      expect.objectContaining({
        id: 'agent-b',
        kind: 'general-purpose',
        description: 'Fix the tests',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'agent-a',
        kind: 'Explore',
        description: 'Map the frontend',
        status: 'done',
      }),
    ]);
    expect(await readSubagentTranscript('claude', 'session-1', cwd, 'agent-a', env())).toEqual([
      { role: 'user', text: 'Look at src/' },
      { role: 'assistant', text: 'It is a React app.' },
    ]);

    // One that stopped writing long ago was cut off, not still running.
    const stale = new Date(Date.now() - 60 * 60_000);
    await utimes(path.join(home, dir, 'agent-b.jsonl'), stale, stale);
    expect((await listSubagents('claude', 'session-1', cwd, env()))[0]?.status).toBe('done');
  });

  it("lists Codex's spawned agents, leaving out its approval reviews and inherited history", async () => {
    const parent = '01a0ebce-0000-7000-8000-000000000001';
    const meta = (id: string, source: unknown, extra: Record<string, unknown> = {}) => ({
      type: 'session_meta',
      payload: {
        id,
        parent_thread_id: parent,
        source,
        timestamp: '2026-09-29T03:00:00.000Z',
        ...extra,
      },
    });
    await file(
      '.codex/sessions/2026/09/29/rollout-a-01a0ebce-0000-7000-8000-00000000000a.jsonl',
      lines([
        meta(
          'child-a',
          { subagent: { thread_spawn: { agent_role: 'worker' } } },
          { subagent_history_start_ordinal: 2 }
        ),
        {
          ordinal: 1,
          type: 'event_msg',
          payload: { type: 'user_message', message: 'the parent asked this' },
        },
        { ordinal: 2, type: 'event_msg', payload: { type: 'task_started' } },
        {
          ordinal: 3,
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Write the migration\nwith details' },
        },
        { ordinal: 4, type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
        { ordinal: 5, type: 'event_msg', payload: { type: 'task_complete' } },
      ])
    );
    await file(
      '.codex/sessions/2026/09/29/rollout-b-01a0ebce-0000-7000-8000-00000000000b.jsonl',
      lines([meta('child-b', { subagent: { other: 'guardian' } })])
    );
    await file(
      '.codex/sessions/2026/09/29/rollout-c-01a0ebce-0000-7000-8000-00000000000c.jsonl',
      lines([
        { type: 'session_meta', payload: { id: 'unrelated', parent_thread_id: 'someone-else' } },
      ])
    );

    expect(await listSubagents('codex', parent, '/', env())).toEqual([
      expect.objectContaining({
        id: 'child-a',
        kind: 'worker',
        description: 'Write the migration',
        status: 'done',
      }),
    ]);
    expect(await readSubagentTranscript('codex', parent, '/', 'child-a', env())).toEqual([
      { role: 'user', text: 'Write the migration\nwith details' },
      { role: 'assistant', text: 'Done.' },
    ]);
  });

  it("reads newer Codex rollouts: the parent's task (maybe encrypted) and the agent's messages", async () => {
    const parent = '01a0e1a8-5fa8-7701-8a25-271bce853a05';
    const agentPath = '/root/review_windows_audit';
    await file(
      '.codex/sessions/2026/09/27/rollout-x-01a0e1a8-fc00-7071-b9ac-de312eb33062.jsonl',
      lines([
        {
          ordinal: 0,
          type: 'session_meta',
          payload: {
            id: 'child',
            parent_thread_id: parent,
            source: {
              subagent: {
                thread_spawn: { agent_path: agentPath, agent_nickname: 'Mendel', agent_role: null },
              },
            },
            subagent_history_start_ordinal: 2,
          },
        },
        {
          ordinal: 1,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'parent history' }],
          },
        },
        {
          ordinal: 2,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'mode' }],
          },
        },
        {
          ordinal: 3,
          type: 'response_item',
          payload: {
            type: 'agent_message',
            author: '/root',
            recipient: agentPath,
            content: [
              {
                type: 'input_text',
                text: 'Message Type: NEW_TASK\nTask name: x\nSender: /root\nPayload:\n',
              },
              { type: 'encrypted_content', encrypted_content: 'gAAAA' },
            ],
          },
        },
        {
          ordinal: 4,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Looking.' }],
          },
        },
        {
          ordinal: 5,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '## Findings' }],
          },
        },
        { ordinal: 6, type: 'event_msg', payload: { type: 'task_complete' } },
      ])
    );

    expect(await listSubagents('codex', parent, '/', env())).toEqual([
      expect.objectContaining({
        kind: 'Mendel',
        description: 'review windows audit',
        status: 'done',
      }),
    ]);
    expect(await readSubagentTranscript('codex', parent, '/', 'child', env())).toEqual([
      {
        role: 'user',
        text: 'Task review windows audit: Codex keeps what it was asked encrypted, so it cannot be shown.',
      },
      { role: 'assistant', text: 'Looking.\n\n## Findings' },
    ]);
  });

  it('knows no subagents for other agents', async () => {
    expect(await listSubagents('opencode', 'x', '/', env())).toEqual([]);
  });
});
