import { createController, type Controller } from '@emdash/wire/rpc';
import { usageStatsContract, type UsageStatsService } from '../api';

export function createUsageStatsWireController(service: UsageStatsService): Controller {
  return createController(usageStatsContract, {
    report: (input) => service.report(input),
    pricing: () => service.pricing(),
    setPricing: (pricing) => service.setPricing(pricing),
  });
}
