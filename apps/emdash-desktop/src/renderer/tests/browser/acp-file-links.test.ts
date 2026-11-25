import '@emdash/chat-ui/style.css';
import { createChatContext, createChatState, createChatView } from '@emdash/chat-ui';
import { expect, it, vi } from 'vitest';
import { createTranscriptFileCommands } from '@core/features/conversations/browser/acp/transcript-file-commands';

it.each(['labelled', 'bare'] as const)(
  'opens a %s ACP short link in the task editor',
  async (format) => {
    const path = '/workspace/portal/front/src/app/base/route/gaea/signin.coffee';
    const href = `https://open-file.emdash.invalid/open?path=${encodeURIComponent(`${path}:1`)}`;
    const context = createChatContext();
    const state = createChatState(context);
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:500px';
    document.body.appendChild(host);
    const openFile = vi.fn(async () => {});
    state.transcript.history.seed([
      {
        id: 'turn-1',
        seq: 0,
        initiator: format === 'labelled' ? 'agent' : 'user',
        items: [
          {
            kind: 'message',
            id: 'message-1',
            seq: 0,
            role: format === 'labelled' ? 'assistant' : 'user',
            text: format === 'labelled' ? `[登录路由](${href})` : href,
          },
        ],
      },
    ]);
    const view = createChatView({
      context,
      state,
      parent: host,
      commands: createTranscriptFileCommands(
        { projectId: 'project-1', taskId: 'task-1' },
        openFile
      ),
    });
    try {
      const link = await vi.waitFor(() => {
        const rendered = host.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
        expect(rendered).not.toBeNull();
        return rendered!;
      });
      if (format === 'labelled') {
        expect(link.textContent).toBe('登录路由');
        expect(host.textContent).not.toContain(href);
      }
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      let intercepted = false;
      const preventNavigation = (event: MouseEvent) => {
        intercepted = event.defaultPrevented;
        event.preventDefault();
      };
      window.addEventListener('click', preventNavigation, { once: true });
      try {
        link.dispatchEvent(event);
        expect(intercepted).toBe(true);
        expect(openFile).toHaveBeenCalledExactlyOnceWith('project-1', 'task-1', path, { line: 1 });
      } finally {
        window.removeEventListener('click', preventNavigation);
      }
    } finally {
      view.dispose();
      state.dispose();
      context.dispose();
      host.remove();
    }
  }
);
