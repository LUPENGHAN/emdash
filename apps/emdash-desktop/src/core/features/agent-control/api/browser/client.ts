import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { agentControlContract, agentControlDomain } from '../index';

export type AgentControlClient = ContractClient<typeof agentControlContract>;

export function getAgentControlClient(): Promise<AgentControlClient> {
  return domainClient<AgentControlClient>(agentControlDomain, agentControlContract);
}
