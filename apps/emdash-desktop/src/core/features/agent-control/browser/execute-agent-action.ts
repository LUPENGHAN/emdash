import {
  tryParsePortableRelativePath,
  type PortableRelativePath,
} from '@emdash/core/primitives/path/api';
import { shortName } from '@emdash/core/runtimes/git/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { toast } from '@emdash/ui/react/primitives';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserDiagnosticsStore } from '@core/features/browser/api/browser/browser-diagnostics-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { sendToConversation } from '@core/features/conversations/api/browser/send-to-conversation';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  agentDisplayName,
  CHAT_CAPABLE_AGENTS,
  handOffConversationTo,
} from '@core/features/conversations/contributions/browser/agent-actions';
import { openFileInTaskEditor } from '@core/features/editor/api/browser/open-file-in-file-editor';
import { fetchAppSettingsMeta } from '@core/features/settings/api/browser/app-settings-client';
import { readCheckoutHead } from '@core/features/source-control/api/browser/client';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTerminalsForTask } from '@core/features/terminals/api/browser/terminal-selectors';
import {
  getTaskComposition,
  getTaskWorkspace,
} from '@core/features/workbench/api/browser/task-composition-selectors';
import { openModal } from '@core/manifests/browser/modal-api';
import { commitRef } from '@core/primitives/git/api';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { resolveTaskBranchName } from '@core/primitives/tasks/api';
import type { AgentCaller, AgentControlAction, AgentControlResult, OpenTarget } from '../api';
import { runBrowserOp, type AutomatableBrowser } from './browser-automation';
import { readableTerminals, renderTerminalTail } from './terminal-reader';

const BROWSER_READY_TIMEOUT_MS = 10_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;

/**
 * Carries out one agent-control action in this window with the same stores and code
 * paths as the UI. Actions that start work, message another agent or run commands ask
 * the user first.
 */
export async function executeAgentAction(
  caller: AgentCaller,
  action: AgentControlAction
): Promise<AgentControlResult> {
  const who = `${agentDisplayName(caller.providerId)} (“${caller.title}”)`;
  switch (action.kind) {
    case 'list_conversations':
      return listConversations(caller, action.scope);

    case 'create_conversation': {
      await confirm(
        `${who} wants to start ${agentDisplayName(action.providerId)}`,
        action.prompt,
        'Start'
      );
      const manager = requireManager(caller);
      const type =
        action.ui === 'chat' && CHAT_CAPABLE_AGENTS.has(action.providerId) ? 'acp' : 'pty';
      const created = await manager.createConversation({
        id: crypto.randomUUID(),
        projectId: caller.projectId,
        taskId: caller.taskId,
        provider: action.providerId as AgentProviderId,
        title: nextDefaultConversationTitle(
          action.providerId,
          Array.from(manager.conversations.values(), (store) => store.data)
        ),
        type,
        ...(action.model && { model: action.model }),
        ...(type === 'acp'
          ? { initialQueue: [{ text: action.prompt }] }
          : { initialPrompt: action.prompt }),
      });
      openConversationTab(caller, created.id, type);
      return { text: `Started ${action.providerId} as conversation ${created.id}.` };
    }

    case 'send_message': {
      const manager = requireManager(caller);
      const target = manager.conversations.get(action.conversationId);
      if (!target) throw new Error(`No conversation ${action.conversationId} in this task`);
      await confirm(`${who} wants to message “${target.data.title}”`, action.text, 'Send');
      await sendToConversation(manager, target.data, action.text);
      return { text: `Sent to “${target.data.title}”.` };
    }

    case 'handoff': {
      const source = requireManager(caller).conversations.get(caller.conversationId);
      if (!source) throw new Error('This conversation is not loaded in Emdash');
      await confirm(
        `${who} wants to hand off to ${agentDisplayName(action.providerId)}`,
        [
          action.model ? `Model: ${action.model}` : null,
          action.note ? `Note: ${action.note}` : null,
          'The new conversation starts with the original ask, the last reply, the git state and the transcript path.',
        ]
          .filter(Boolean)
          .join('\n'),
        'Hand off'
      );
      const created = await handOffConversationTo(source.data, action);
      return {
        text: `Handed off to ${action.providerId} (conversation ${created.id}). You can stop here.`,
      };
    }

    case 'suggest_task': {
      toast.info(`${agentDisplayName(caller.providerId)} suggests a task: ${action.title}`, {
        description: action.prompt.slice(0, 200),
        duration: 60_000,
        action: {
          label: 'Create task',
          onClick: () =>
            void openModal('taskModal', {
              projectId: caller.projectId,
              initialName: action.title,
              initialPrompt: action.prompt,
            }),
        },
      });
      return { text: 'Suggested to the user; they can start it from the notification.' };
    }

    case 'create_task':
      return createTaskForAgent(caller, action, who);

    case 'open':
      return openTarget(caller, action.target);

    case 'read_terminal':
      return readTerminal(caller, action.name, action.lines);

    case 'run_in_terminal': {
      await confirm(`${who} wants to run a command`, action.command, 'Run');
      const composition = getTaskComposition(caller.projectId, caller.taskId);
      const terminals = getTerminalsForTask(caller.taskId);
      if (!composition || !terminals)
        throw new Error('Open the task in Emdash to run commands in it');
      // Opens the terminal drawer on a new terminal, so the user sees it run.
      const terminalId = await composition.openNewTerminal();
      const session = terminalId ? terminals.sessions.get(terminalId) : undefined;
      await session?.connect();
      if (!terminalId || !session?.pty) throw new Error('The terminal did not start');
      session.pty.sendInput(`${action.command}\r`);
      const name = terminals.terminals.get(terminalId)?.data.name ?? 'the new terminal';
      return { text: `Running in “${name}”. Use read_terminal to see its output.` };
    }

    case 'notify': {
      const title = action.title ?? `${agentDisplayName(caller.providerId)} · ${caller.title}`;
      toast.info(title, { description: action.message });
      try {
        new Notification(title, { body: action.message });
      } catch {
        // Browsers may refuse system notifications; the toast is enough.
      }
      return { text: 'Notified the user.' };
    }

    case 'browser': {
      const browser = await taskBrowser(
        caller,
        action.browser.op === 'open' ? action.browser.url : undefined
      );
      return runBrowserOp(browser, action.browser);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * A task with its own worktree, created the way the new-task dialog does (the project's
 * branch prefix and worktree location), so the agent's worktree is one the user sees.
 */
async function createTaskForAgent(
  caller: AgentCaller,
  action: Extract<AgentControlAction, { kind: 'create_task' }>,
  who: string
): Promise<AgentControlResult> {
  const taskManager = getTaskManagerStore(caller.projectId);
  if (!taskManager) throw new Error('This project is not open in Emdash.');
  const callerWorkspace = getTaskWorkspace(caller.projectId, caller.taskId);
  const callerBranch = callerWorkspace
    ? await readCheckoutHead(callerWorkspace.workspaceId)
        .then((head) => (head.kind === 'detached' ? null : shortName(head.ref)))
        .catch(() => null)
    : null;
  const baseBranch =
    action.baseBranch?.trim() ||
    callerBranch ||
    getGitRepositoryStore(caller.projectId)?.defaultBranchRef?.branch;
  if (!baseBranch) throw new Error('Name the branch to start from (base_branch).');

  const project = (await fetchAppSettingsMeta('project').catch(() => undefined))?.value;
  const name = action.name.trim();
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task';
  const branchName = resolveTaskBranchName({
    rawBranch: slug,
    branchPrefix: project?.branchPrefix ?? '',
    suffix: Math.random().toString(36).slice(2, 7),
    appendRandomSuffix: project?.appendRandomBranchSuffix ?? true,
  });

  const detail = [
    `Branch ${branchName} from ${baseBranch}, in a new worktree.`,
    action.prompt
      ? `Then starts ${agentDisplayName(action.providerId ?? caller.providerId)} there with:\n${action.prompt}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  await confirm(`${who} wants to create the task “${name}”`, detail, 'Create');

  const id = crypto.randomUUID();
  const providerId = action.providerId ?? caller.providerId;
  const type = action.ui === 'chat' && CHAT_CAPABLE_AGENTS.has(providerId) ? 'acp' : 'pty';
  await taskManager.createTask({
    id,
    projectId: caller.projectId,
    taskConfig: {
      version: '1',
      name,
      ...(action.prompt && {
        initialConversation: {
          id: crypto.randomUUID(),
          provider: providerId as AgentProviderId,
          title: nextDefaultConversationTitle(providerId, []),
          type,
          ...(type === 'acp'
            ? { initialQueue: [{ text: action.prompt }] }
            : { initialPrompt: action.prompt }),
        },
      }),
    },
    workspaceConfig: {
      version: '2',
      git: {
        kind: 'create-branch',
        branchName,
        fromBranch: { type: 'local', branch: baseBranch },
      },
      workspace: { kind: 'new-worktree' },
    },
  });
  // The workspace reaches this window's registry shortly after provisioning.
  let path = getTaskWorkspace(caller.projectId, id)?.path;
  for (let waited = 0; !path && waited < 10_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    path = getTaskWorkspace(caller.projectId, id)?.path;
  }
  toast.success(`${agentDisplayName(caller.providerId)} created the task “${name}”`, {
    action: {
      label: 'Open',
      onClick: () =>
        getNavigation().navigate(taskViewDef({ projectId: caller.projectId, taskId: id })),
    },
  });
  return {
    text: [
      `Created the task "${name}" (${id}) on branch ${branchName}, from ${baseBranch}.`,
      path ? `Worktree: ${path}` : 'Its worktree is still being prepared.',
      action.prompt ? `${providerId} is starting there with your message.` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function confirm(title: string, detail: string, confirmLabel: string): Promise<void> {
  const outcome = await openModal('confirmActionModal', {
    title,
    description: detail,
    confirmLabel,
    variant: 'default',
  });
  if (!outcome.success) throw new Error('The user declined in Emdash.');
}

function requireManager(caller: AgentCaller) {
  const manager = conversationRegistry.get(caller.taskId);
  if (!manager) throw new Error('Open the task in Emdash first');
  return manager;
}

function openConversationTab(caller: AgentCaller, conversationId: string, type: 'acp' | 'pty') {
  getTaskComposition(caller.projectId, caller.taskId)?.paneLayout.open(
    type === 'acp' ? 'acp-chat' : 'conversation',
    { conversationId },
    { preview: false }
  );
}

async function listConversations(
  caller: AgentCaller,
  scope: 'task' | 'project'
): Promise<AgentControlResult> {
  if (scope === 'project') {
    const all = await (
      await getConversationsClient()
    ).getConversationsForProject({ projectId: caller.projectId });
    return {
      text:
        all
          .map(
            (c) =>
              `${c.id} · ${c.providerId} · task ${c.taskId}${c.id === caller.conversationId ? ' (you)' : ''} · ${c.title}`
          )
          .join('\n') || 'No conversations.',
    };
  }
  const manager = requireManager(caller);
  const lines = Array.from(manager.conversations.values(), (store) => {
    const c = store.data;
    return `${c.id} · ${c.providerId}${c.model ? ` (${c.model})` : ''} · ${c.type === 'acp' ? 'chat' : 'terminal'} · ${store.status}${c.id === caller.conversationId ? ' (you)' : ''} · ${c.title}`;
  });
  return { text: lines.join('\n') || 'No conversations.' };
}

async function openTarget(caller: AgentCaller, target: OpenTarget): Promise<AgentControlResult> {
  switch (target.type) {
    case 'file':
      await openFileInTaskEditor(caller.projectId, caller.taskId, target.path, {
        ...(target.line !== undefined && { line: target.line }),
      });
      return { text: `Showing ${target.path}${target.line ? `:${target.line}` : ''}.` };
    case 'diff': {
      const composition = getTaskComposition(caller.projectId, caller.taskId);
      if (!composition) throw new Error('Open the task in Emdash first');
      composition.paneLayout.focusedPane.open(
        'diff',
        {
          activeFile: target.staged
            ? {
                path: taskRelative(caller, target.path),
                type: 'git',
                group: 'staged',
                originalRef: commitRef('HEAD'),
              }
            : {
                path: taskRelative(caller, target.path),
                type: 'disk',
                group: 'disk',
                originalRef: commitRef('HEAD'),
              },
          status: 'modified',
        },
        { preview: false }
      );
      return { text: `Showing the diff of ${target.path}.` };
    }
    case 'url': {
      const browser = await taskBrowser(caller, target.url);
      await browser.loadUrl(target.url);
      return { text: `Showing ${target.url} in the built-in browser.` };
    }
  }
}

/** A path inside the task, relative to its working directory. */
function taskRelative(caller: AgentCaller, path: string): PortableRelativePath {
  const inside =
    caller.cwd && path.startsWith(`${caller.cwd}/`) ? path.slice(caller.cwd.length + 1) : path;
  const relative = tryParsePortableRelativePath(inside);
  if (!relative) throw new Error(`Use a path inside the task: ${path}`);
  return relative;
}

// ── Terminals ──────────────────────────────────────────────────────────────────

async function readTerminal(
  caller: AgentCaller,
  name: string | undefined,
  lines: number
): Promise<AgentControlResult> {
  const terminals = readableTerminals(caller.taskId, caller.conversationId);
  if (terminals.length === 0) return { text: 'This task has no terminals to read.' };
  const wanted = name?.toLowerCase();
  const picked = wanted
    ? terminals.find((terminal) => terminal.name.toLowerCase().includes(wanted))
    : terminals[0];
  if (!picked) {
    return {
      text: `No terminal named “${name}”. Terminals: ${terminals.map((t) => t.name).join(', ')}`,
    };
  }
  const text = await renderTerminalTail(picked, lines);
  return {
    text: `${picked.kind === 'shell' ? 'Terminal' : 'Agent'} “${picked.name}” (last ${lines} lines):\n${text || '(no output yet)'}`,
  };
}

// ── Built-in browser ─────────────────────────────────────────────────────────────

/**
 * The task's browser, ready to drive. `openUrl` is the page about to be opened: a browser
 * on its start page has no page (no webview) to drive, so that page is what brings one up.
 */
async function taskBrowser(caller: AgentCaller, openUrl?: string): Promise<AutomatableBrowser> {
  const composition = getTaskComposition(caller.projectId, caller.taskId);
  if (!composition) throw new Error('Open the task in Emdash to use its browser');
  const findBrowserId = () => {
    for (const group of composition.paneLayout.groups) {
      for (const tab of group.pane.resolvedTabs) {
        if (tab.kind === 'browser')
          return (tab.resource as unknown as { browserId: string }).browserId;
      }
    }
    return null;
  };
  let browserId = findBrowserId();
  if (!browserId) {
    // Blank first: callers load their URL once the tab's webview is ready.
    composition.paneLayout.open('browser', { initialUrl: 'about:blank' }, { preview: false });
    browserId = findBrowserId();
  }
  if (!browserId) throw new Error('Could not open the built-in browser');
  const id = browserId;
  // A browser runs only while its task is on screen: the task's panes (and every tab in
  // them, hidden ones included) are not mounted while another view is showing. The agent
  // asked to use it, so bring its task to the front rather than fail.
  if (!browserControlsRegistry.get(id)) {
    getNavigation().navigate(taskViewDef({ projectId: caller.projectId, taskId: caller.taskId }));
  }
  const controls = await waitFor(
    () => browserControlsRegistry.get(id) ?? null,
    BROWSER_READY_TIMEOUT_MS,
    'The built-in browser did not come up; open its task in Emdash and try again'
  );
  let opened: string | null = null;
  if (!controls.adapter && browserSessionStore.getSession(id)?.currentUrl === 'about:blank') {
    if (!openUrl) throw new Error('No page is open in the built-in browser; use browser_open');
    controls.loadUrl(openUrl);
    opened = openUrl;
  }
  const adapter = await waitFor(
    () => browserControlsRegistry.get(id)?.adapter ?? null,
    BROWSER_READY_TIMEOUT_MS,
    'The built-in browser did not come up; open its task in Emdash and try again'
  );
  const waitForLoad = () =>
    waitFor(
      () => (browserSessionStore.getSession(id)?.isLoading === false ? true : null),
      PAGE_LOAD_TIMEOUT_MS,
      'The page is still loading'
    );
  return {
    executeJavaScript: (code) => adapter.executeJavaScript(code),
    capturePng: () => adapter.capturePng(),
    sendInputEvent: (event) => adapter.sendInputEvent(event),
    insertText: (text) => adapter.insertText(text),
    loadUrl: async (url) => {
      // Already on its way: the start page just loaded it to bring the page up.
      if (opened !== url) await adapter.loadUrl(url);
      opened = null;
      await waitForLoad().catch(() => {});
    },
    currentUrl: () => adapter.currentUrl(),
    title: () => adapter.title(),
    consoleEntries: () =>
      browserDiagnosticsStore.entriesForBrowser(id).map((entry) => ({
        level: entry.level,
        message: entry.message,
        url: entry.url,
        line: entry.line,
      })),
  };
}

async function waitFor<T>(read: () => T | null, timeoutMs: number, message: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
