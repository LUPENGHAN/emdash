import { createController, type Controller } from '@emdash/wire/rpc';
import { remoteClientContract, type RemoteClientService } from '../api';

export function createRemoteClientWireController(service: RemoteClientService): Controller {
  return createController(remoteClientContract, {
    state: () => service.state(),
    addServer: (input) => service.addServer(input),
    removeServer: ({ id }) => service.removeServer(id),
    switchTo: ({ serverId }) => service.switchTo(serverId),
    openWindow: ({ serverId }) => service.openWindow(serverId),
  });
}
