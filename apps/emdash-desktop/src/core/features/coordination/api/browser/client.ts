import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { coordinationContract, coordinationDomain } from '../contract';

export function getCoordinationClient(): Promise<ContractClient<typeof coordinationContract>> {
  return domainClient(coordinationDomain, coordinationContract);
}
