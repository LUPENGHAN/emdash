import { createController, type Controller } from '@emdash/wire/rpc';
import { agentControlContract } from '../api';
import type { AgentControlDispatcher } from './agent-control-dispatcher';
import { agentControlEvents, agentMessageEvents } from './event-host';

export function createAgentControlWireController(dispatcher: AgentControlDispatcher): Controller {
  return createController(agentControlContract, {
    requests: agentControlEvents,
    messagesChanged: agentMessageEvents,
    pendingMessages: ({ taskId }) => dispatcher.pendingMessages(taskId),
    resolvePendingMessage: ({ taskId, id, resolution }) =>
      dispatcher.resolvePendingMessage(taskId, id, resolution),
    register: ({ rendererId, focused }) => dispatcher.register(rendererId, focused),
    respond: (input) => dispatcher.respond(input),
  });
}
