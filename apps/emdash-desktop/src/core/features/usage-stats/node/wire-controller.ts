import { createController, type Controller } from '@emdash/wire/rpc';
import { usageStatsContract, type UsageStatsService } from '../api';

export function createUsageStatsWireController(service: UsageStatsService): Controller {
  return createController(usageStatsContract, {
    report: (input) => service.report(input),
    pricing: () => service.pricing(),
    setPricing: (pricing) => service.setPricing(pricing),
    prices: ({ models }) => service.prices(models),
    setModelPrice: ({ model, price }) => service.setModelPrice(model, price),
    modelListings: ({ model }) => service.modelListings(model),
    refreshPrices: () => service.refreshPrices(),
  });
}
