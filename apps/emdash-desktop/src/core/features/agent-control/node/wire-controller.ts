import { createController, type Controller } from '@emdash/wire/rpc';
import { agentControlContract } from '../api';
import type { AgentControlDispatcher } from './agent-control-dispatcher';
import { agentControlEvents } from './event-host';

export function createAgentControlWireController(dispatcher: AgentControlDispatcher): Controller {
  return createController(agentControlContract, {
    requests: agentControlEvents,
    register: ({ rendererId, focused }) => dispatcher.register(rendererId, focused),
    respond: (input) => dispatcher.respond(input),
  });
}
