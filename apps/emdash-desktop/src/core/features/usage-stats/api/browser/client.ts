import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { usageStatsContract, usageStatsDomain } from '../index';

export function getUsageStatsClient(): Promise<ContractClient<typeof usageStatsContract>> {
  return domainClient(usageStatsDomain, usageStatsContract);
}
