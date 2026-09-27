import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { agentLibraryContract, agentLibraryDomain } from '../index';

export type AgentLibraryClient = ContractClient<typeof agentLibraryContract>;

export function getAgentLibraryClient(): Promise<AgentLibraryClient> {
  return domainClient<AgentLibraryClient>(agentLibraryDomain, agentLibraryContract);
}
