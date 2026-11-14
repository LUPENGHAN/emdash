import { createController, type Controller } from '@emdash/wire/rpc';
import { modelGatewayContract } from '../api/contract';
import type { ModelGatewayService } from './gateway-service';

export function createModelGatewayWireController(service: ModelGatewayService): Controller {
  return createController(modelGatewayContract, {
    status: () => service.status(),
    start: () => service.start(),
    stop: () => service.stop(),
    usage: ({ limit }) => service.usage(limit),
    routes: () => service.routes(),
    beginOAuth: ({ provider }) => service.beginOAuth(provider),
    oauthStatus: ({ state }) => service.oauthStatus(state),
    completeOAuth: ({ provider, redirectUrl }) => service.completeOAuth(provider, redirectUrl),
    removeAccount: ({ id }) => service.removeAccount(id),
    route: ({ conversationId }) => service.route(conversationId),
    switchRoute: (input) => service.switchRoute(input),
  });
}
