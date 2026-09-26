import { createController, type Controller } from '@emdash/wire/rpc';
import { remoteAccessContract, type RemoteAccessService } from '../api';

export function createRemoteAccessWireController(service: RemoteAccessService): Controller {
  return createController(remoteAccessContract, {
    status: () => service.status(),
    link: () => service.link(),
    regenerateToken: () => service.regenerateToken(),
  });
}
