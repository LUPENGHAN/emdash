import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { modelGatewayContract, modelGatewayDomain } from '../contract';

export function getModelGatewayClient(): Promise<ContractClient<typeof modelGatewayContract>> {
  return domainClient(modelGatewayDomain, modelGatewayContract);
}
