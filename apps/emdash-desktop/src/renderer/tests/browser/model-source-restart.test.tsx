import { beforeEach, expect, it, vi } from 'vitest';
import { restartConversation } from '@core/features/conversations/browser/restart-conversation';
import type { Conversation } from '@core/primitives/conversations/api';

const mocks = vi.hoisted(() => ({
  conversation: {} as Conversation,
  check: vi.fn(),
  kill: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  route: vi.fn(),
  events: [] as string[],
}));
vi.mock('@core/features/agents/api/browser/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentsClient: async () => ({ checkModelSource: mocks.check }),
}));
vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({
    getConversationsForTask: async () => [mocks.conversation],
  }),
}));
vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: {
    get: () => ({
      killSession: mocks.kill,
      createConversation: mocks.create,
      deleteConversation: mocks.remove,
    }),
  },
}));
vi.mock('@core/features/model-gateway/api/browser/client', () => ({
  getModelGatewayClient: async () => ({
    route: mocks.route,
    status: async () => ({ providers: [], models: [] }),
  }),
}));
vi.mock('@core/features/conversations/browser/handoff', () => ({
  agentDisplayName: (id: string) => id,
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  openModal: vi.fn(),
  useModalController: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events = [];
  mocks.conversation = {
    id: 'original',
    taskId: 'task',
    projectId: 'project',
    providerId: 'claude',
    type: 'pty',
    title: 'Work',
    sessionId: 'saved-session',
    modelSource: 'gateway:models',
    sourceModel: 'fast',
    lastInteractedAt: null,
    isInitialConversation: false,
    agentStatus: 'idle',
    agentStatusSeen: true,
  };
  mocks.check.mockResolvedValue({ error: null });
  mocks.route.mockResolvedValue({
    sourceId: 'gateway:models',
    model: 'fast',
    requiresNewSession: true,
    restartReason: 'Provider changed',
  });
  mocks.kill.mockImplementation(async () => {
    mocks.events.push('stopped');
  });
  mocks.create.mockImplementation(async () => {
    mocks.events.push('created');
    return { ...mocks.conversation, id: 'replacement' };
  });
  mocks.remove.mockImplementation(async () => {
    mocks.events.push('removed');
  });
});
it('keeps the original conversation recoverable if replacement startup fails', async () => {
  mocks.create.mockRejectedValueOnce(new Error('Agent failed to start'));
  await expect(restartConversation(mocks.conversation, { modelSource: null })).rejects.toThrow(
    'Agent failed'
  );
  expect(mocks.kill).toHaveBeenCalledWith('original');
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('creates a fresh provider session before removing the original record', async () => {
  await restartConversation(mocks.conversation, { modelSource: null });
  expect(mocks.events).toEqual(['stopped', 'created', 'removed']);
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('providerSessionId');
});
it('refuses an unsafe resume and validates before stopping anything', async () => {
  await expect(
    restartConversation(mocks.conversation, { modelSource: null }, { requireSession: true })
  ).rejects.toThrow('cannot safely resume');
  expect(mocks.kill).not.toHaveBeenCalled();
  mocks.check.mockResolvedValueOnce({ error: 'Model unavailable' });
  await expect(restartConversation(mocks.conversation, { modelSource: null })).rejects.toThrow(
    'Model unavailable'
  );
  expect(mocks.kill).not.toHaveBeenCalled();
});
