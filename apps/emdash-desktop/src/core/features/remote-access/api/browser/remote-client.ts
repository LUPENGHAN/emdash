import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { remoteClientContract, remoteClientDomain } from '../index';

export type RemoteClientClient = ContractClient<typeof remoteClientContract>;

export function getRemoteClientClient(): Promise<RemoteClientClient> {
  return domainClient<RemoteClientClient>(remoteClientDomain, remoteClientContract);
}
