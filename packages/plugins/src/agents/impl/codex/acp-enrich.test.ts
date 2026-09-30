import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser, decodeSessionUpdate } from '@emdash/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { enrichCodexUpdate } from './acp-enrich';

const startupFailure = (server: string): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: `mcp_startup.${encodeURIComponent(server)}`,
  title: `mcp__${server}__startup`,
  kind: 'other',
  status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: 'Connection refused' } }],
});

describe('Codex MCP startup diagnostics', () => {
  it('extracts the server identity without parsing diagnostic prose', () => {
    const raw = startupFailure('docs / team_ä');
    expect(enrichCodexUpdate(decodeSessionUpdate(raw), raw)).toEqual({
      kind: 'mcp_startup_failure',
      server: 'docs / team_ä',
      error: 'Connection refused',
    });
  });

  it.each([
    { toolCallId: 'ordinary-tool-call' },
    { toolCallId: 'mcp_startup.%ZZ' },
    { title: 'mcp__docs__search' },
    { status: 'completed' as const },
    { kind: 'execute' as const },
  ])('preserves nonmatching events: %j', (overrides) => {
    const raw = { ...startupFailure('docs'), ...overrides } as SessionUpdate;
    const decoded = decodeSessionUpdate(raw);
    expect(enrichCodexUpdate(decoded, raw)).toBe(decoded);
  });
});

describe('codex command output', () => {
  // As codex-acp 1.13 sends a command run through its own (client-less) terminal.
  const started = {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    title: 'echo hello; echo second',
    kind: 'execute',
    status: 'in_progress',
    content: [{ type: 'terminal', terminalId: 'call_1' }],
    _meta: { terminal_info: { cwd: '/repo', terminal_id: 'call_1' } },
  } as unknown as SessionUpdate;
  const completed = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: 'completed',
    rawOutput: { formatted_output: 'hello\nsecond\n', exit_code: 0 },
    _meta: {
      terminal_output_delta: { data: 'hello\nsecond\n', terminal_id: 'call_1' },
      terminal_exit: { exit_code: 0, signal: null, terminal_id: 'call_1' },
    },
  } as unknown as SessionUpdate;

  it('shows the output codex reports outside the tool content', () => {
    const replay = AcpTranscriptParser.replay([started, completed], {
      conversationId: 'c',
      enrich: enrichCodexUpdate,
    });
    const turns = [...replay.committed, ...(replay.active ? [replay.active] : [])];
    expect(JSON.stringify(turns)).toContain('"outputText":"hello\\nsecond"');
  });

  it('falls back to the terminal output meta, and keeps output the tool content has', () => {
    const metaOnly = { ...completed, rawOutput: undefined } as unknown as SessionUpdate;
    expect(enrichCodexUpdate(decodeSessionUpdate(metaOnly)!, metaOnly)).toMatchObject({
      outputText: 'hello\nsecond',
    });
    const withContent = {
      ...completed,
      content: [{ type: 'content', content: { type: 'text', text: 'from content' } }],
    } as unknown as SessionUpdate;
    expect(enrichCodexUpdate(decodeSessionUpdate(withContent)!, withContent)).toMatchObject({
      outputText: 'from content',
    });
  });
});
