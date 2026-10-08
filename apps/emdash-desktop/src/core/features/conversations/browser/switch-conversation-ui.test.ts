import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import {
  canSwitchConversationUi,
  switchConversationUiCommands,
  switchTarget,
} from './switch-conversation-ui';

vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: { get: vi.fn() },
}));

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    projectId: 'p',
    taskId: 't',
    providerId: 'claude',
    title: 'Chat',
    isInitialConversation: false,
    type: 'pty',
    ...overrides,
  } as Conversation;
}

vi.mock('@core/features/workbench/api/browser/task-composition-selectors', () => ({
  getTaskComposition: vi.fn(),
}));

const sshConnection = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectSshConnectionId: () => sshConnection.id,
}));

describe('canSwitchConversationUi', () => {
  it('offers terminal conversations whose real session id is known', () => {
    expect(canSwitchConversationUi(conversation({ sessionId: 'native-1' }))).toBe(true);
    expect(
      canSwitchConversationUi(conversation({ providerId: 'codex', sessionId: 'thread-1' }))
    ).toBe(true);
  });

  it("treats Claude's conversation-id handle as real (spawned with --session-id)", () => {
    expect(canSwitchConversationUi(conversation({ sessionId: 'conv-1' }))).toBe(true);
  });

  it('offers conversations without a session yet, labelled as starting a new one', () => {
    const fresh = conversation({ providerId: 'codex', sessionId: 'conv-1' });
    expect(canSwitchConversationUi(fresh)).toBe(true);
    expect(canSwitchConversationUi(conversation({}))).toBe(true);
    expect(switchConversationUiCommands(fresh)[0]?.label).toBe('Switch to chat UI (new session)');
    expect(
      switchConversationUiCommands(conversation({ providerId: 'codex', sessionId: 'thread-1' }))[0]
        ?.label
    ).toBe('Switch to chat UI');
  });

  it('skips agents that cannot resume a session in both UIs', () => {
    expect(
      canSwitchConversationUi(conversation({ providerId: 'amp' as never, sessionId: 'T-1' }))
    ).toBe(false);
    expect(canSwitchConversationUi(conversation({ providerId: 'pi', sessionId: 'x' }))).toBe(false);
  });

  it('switches Cursor only on this computer, where its session can be moved', () => {
    const cursor = conversation({ providerId: 'cursor', sessionId: 'conv-1' });
    expect(canSwitchConversationUi(cursor)).toBe(true);
    sshConnection.id = 'ssh-1';
    try {
      expect(canSwitchConversationUi(cursor)).toBe(false);
      expect(canSwitchConversationUi(conversation({ sessionId: 'native-1' }))).toBe(true);
    } finally {
      sshConnection.id = undefined;
    }
  });

  it('offers chat conversations switching back to the terminal', () => {
    const chat = conversation({ type: 'acp', providerId: 'codex', sessionId: 'thread-1' });
    expect(canSwitchConversationUi(chat)).toBe(true);
    expect(switchTarget(chat)).toBe('pty');
    expect(switchTarget(conversation({ sessionId: 'native-1' }))).toBe('acp');
  });
});
