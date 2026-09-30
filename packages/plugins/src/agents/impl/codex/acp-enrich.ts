import type { EnrichHook } from '@emdash/core/runtimes/acp/api';

/**
 * codex-acp runs commands itself and reports their output not as tool content but as
 * `rawOutput.formatted_output` and terminal `_meta` for a terminal the client never
 * created (named after the tool call), so the command's result would show as empty.
 * The completed output becomes the tool's output text.
 */
function withCommandOutput(
  event: Parameters<EnrichHook>[0],
  raw: Parameters<EnrichHook>[1]
): Parameters<EnrichHook>[0] {
  if (event.kind !== 'tool_update' || event.outputText !== undefined) return event;
  if (raw.sessionUpdate !== 'tool_call_update') return event;
  const output = commandOutput(raw);
  return output === undefined ? event : { ...event, outputText: output };
}

function commandOutput(raw: Parameters<EnrichHook>[1]): string | undefined {
  const rawOutput = (raw as { rawOutput?: unknown }).rawOutput as
    | { formatted_output?: unknown }
    | null
    | undefined;
  if (typeof rawOutput?.formatted_output === 'string' && rawOutput.formatted_output) {
    return rawOutput.formatted_output.replace(/\n+$/, '');
  }
  const meta = (raw as { _meta?: unknown })._meta as
    | Record<string, { data?: unknown } | undefined>
    | null
    | undefined;
  const data = meta?.terminal_output?.data ?? meta?.terminal_output_delta?.data;
  return typeof data === 'string' && data ? data.replace(/\n+$/, '') : undefined;
}

/** codex-acp represents startup diagnostics as synthetic failed tool calls. */
export const enrichCodexUpdate: EnrichHook = (incoming, raw) => {
  const event = withCommandOutput(incoming, raw);
  if (
    event.kind !== 'tool_call' ||
    event.status !== 'failed' ||
    event.toolKind !== 'other' ||
    event.parentToolCallId !== null ||
    !event.toolCallId.startsWith('mcp_startup.')
  )
    return event;

  let server: string;
  try {
    server = decodeURIComponent(event.toolCallId.slice('mcp_startup.'.length));
  } catch {
    return event;
  }
  if (!server || event.title !== `mcp__${server}__startup`) return event;
  const error =
    raw.sessionUpdate === 'tool_call'
      ? raw.content
          ?.flatMap((entry) =>
            entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : []
          )
          .join('\n')
      : undefined;
  return {
    kind: 'mcp_startup_failure',
    server,
    error: error || 'MCP server failed to start.',
  };
};
