import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import { canSwitchConversationUi, switchTarget } from './switch-conversation-ui';

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

  it('skips placeholders, chat conversations, unknown providers and missing ids', () => {
    expect(
      canSwitchConversationUi(conversation({ providerId: 'codex', sessionId: 'conv-1' }))
    ).toBe(false);
    expect(
      canSwitchConversationUi(conversation({ providerId: 'amp' as never, sessionId: 'T-1' }))
    ).toBe(false);
    expect(canSwitchConversationUi(conversation({}))).toBe(false);
  });

  it('offers chat conversations switching back to the terminal', () => {
    const chat = conversation({ type: 'acp', providerId: 'codex', sessionId: 'thread-1' });
    expect(canSwitchConversationUi(chat)).toBe(true);
    expect(switchTarget(chat)).toBe('pty');
    expect(switchTarget(conversation({ sessionId: 'native-1' }))).toBe('acp');
  });
});
