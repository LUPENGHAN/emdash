import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import { canSwitchToChatUi } from './switch-to-chat-ui';

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

describe('canSwitchToChatUi', () => {
  it('offers terminal conversations whose real session id is known', () => {
    expect(canSwitchToChatUi(conversation({ sessionId: 'native-1' }))).toBe(true);
    expect(canSwitchToChatUi(conversation({ providerId: 'codex', sessionId: 'thread-1' }))).toBe(
      true
    );
  });

  it("treats Claude's conversation-id handle as real (spawned with --session-id)", () => {
    expect(canSwitchToChatUi(conversation({ sessionId: 'conv-1' }))).toBe(true);
  });

  it('skips placeholders, chat conversations, unknown providers and missing ids', () => {
    expect(canSwitchToChatUi(conversation({ providerId: 'codex', sessionId: 'conv-1' }))).toBe(
      false
    );
    expect(canSwitchToChatUi(conversation({ type: 'acp', sessionId: 'native-1' }))).toBe(false);
    expect(canSwitchToChatUi(conversation({ providerId: 'amp' as never, sessionId: 'T-1' }))).toBe(
      false
    );
    expect(canSwitchToChatUi(conversation({}))).toBe(false);
  });
});
