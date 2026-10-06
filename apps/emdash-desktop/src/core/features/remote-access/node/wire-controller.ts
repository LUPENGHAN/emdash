import { createController, type Controller } from '@emdash/wire/rpc';
import { remoteAccessContract, type RemoteAccessService } from '../api';

export function createRemoteAccessWireController(service: RemoteAccessService): Controller {
  return createController(remoteAccessContract, {
    status: () => service.status(),
    links: () => service.links(),
    regenerateToken: () => service.regenerateToken(),
    devices: () => service.devices(),
    revokeDevice: ({ id }) => service.revokeDevice(id),
    accessKey: () => service.accessKey(),
    setAccessKey: ({ key }) => service.setAccessKey(key),
  });
}
