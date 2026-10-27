import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { memoryContract, memoryDomain } from '../contract';

export type MemoryClient = ContractClient<typeof memoryContract>;

export function getMemoryClient(): Promise<MemoryClient> {
  return domainClient<MemoryClient>(memoryDomain, memoryContract);
}
