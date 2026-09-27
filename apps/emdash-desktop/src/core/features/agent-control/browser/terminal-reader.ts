import { ReplicaLog } from '@emdash/wire/live';
import { Terminal } from '@xterm/xterm';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTerminalsClient } from '@core/features/terminals/api/browser/client';
import { createXtermLogSink } from '@core/features/terminals/api/browser/pty/xterm-log-sink';
import { getTerminalsForTask } from '@core/features/terminals/api/browser/terminal-selectors';

type OutputHandle = ConstructorParameters<typeof ReplicaLog>[0];

export type ReadableTerminal = {
  name: string;
  kind: 'shell' | 'agent';
  handle: () => Promise<OutputHandle>;
};

/**
 * Terminals in a task an agent can read: the task's shells (newest first), then other
 * agents' terminal conversations. The caller's own conversation is left out.
 */
export function readableTerminals(
  taskId: string,
  excludeConversationId: string
): ReadableTerminal[] {
  const out: ReadableTerminal[] = [];
  const terminals = getTerminalsForTask(taskId);
  for (const [id, store] of [...(terminals?.terminals ?? [])].reverse()) {
    out.push({
      name: store.data.name,
      kind: 'shell',
      handle: async () => {
        let key = terminals!.runtimeKeys.get(id);
        if (!key) {
          await terminals!.hydrateTerminal(id);
          key = terminals!.runtimeKeys.get(id);
        }
        if (!key) throw new Error(`Terminal “${store.data.name}” is not running`);
        return (await getTerminalsClient()).output.handle(key) as OutputHandle;
      },
    });
  }
  const manager = conversationRegistry.get(taskId);
  for (const store of manager?.conversations.values() ?? []) {
    if (store.data.id === excludeConversationId || store.data.type === 'acp') continue;
    out.push({
      name: store.data.title,
      kind: 'agent',
      handle: async () =>
        (await getConversationsClient()).tui.output.handle({
          conversationId: store.data.id,
        }) as OutputHandle,
    });
  }
  return out;
}

/**
 * The last `lines` rows of a terminal as the user would see them: its output log is
 * replayed into a detached xterm (never opened, so layout does not matter), which
 * applies cursor movement and redraws the way the visible terminal does.
 */
export async function renderTerminalTail(
  terminal: ReadableTerminal,
  lines: number
): Promise<string> {
  const xterm = new Terminal({ cols: 160, rows: 50, scrollback: 5_000, allowProposedApi: true });
  const log = new ReplicaLog(await terminal.handle(), { store: createXtermLogSink(xterm) });
  try {
    await log.ready;
    // Writes are applied asynchronously; an empty write resolves after the queue drains.
    await new Promise<void>((resolve) => xterm.write('', resolve));
    const buffer = xterm.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    while (rows.length > 0 && rows.at(-1) === '') rows.pop();
    return rows.slice(-lines).join('\n');
  } finally {
    await log.dispose();
    xterm.dispose();
  }
}
