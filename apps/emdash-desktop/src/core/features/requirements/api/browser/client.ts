import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { requirementsContract, requirementsDomain } from '../contract';

export type RequirementsClient = ContractClient<typeof requirementsContract>;

export function getRequirementsClient(): Promise<RequirementsClient> {
  return domainClient<RequirementsClient>(requirementsDomain, requirementsContract);
}
