import type { PendingLease } from '@emdash/shared';
import {
  createWireSessionHub,
  exposeWireToWindows,
  WireError,
  type Controller,
  type LiveSource,
  type WireSessionHub,
  type WireTransport,
} from '@emdash/wire/rpc';
import { ipcMain, MessageChannelMain } from 'electron';
import { DESKTOP_WIRE_CHANNEL } from '@core/manifests/shared/wire-channels';
import type { ControllersBundle } from '@main/bootstrap/boot/phases/controllers';
import { appScope } from '@main/bootstrap/core/app-scope';

const scope = appScope.child('desktop-wire');
let installed = false;
let registeredControllers: Record<string, Controller> | undefined;
let resolveControllers: ((controllers: Record<string, Controller>) => void) | undefined;
const controllersPromise = new Promise<Record<string, Controller>>((resolve) => {
  resolveControllers = resolve;
});

/**
 * Installs the renderer-facing wire port handler. Safe to call before the
 * controllers bundle exists: port requests are granted immediately and any
 * traffic queues inside the lazy routing controller until
 * `registerDesktopWireControllers` provides the bundle.
 */
export function installDesktopWire(): void {
  if (installed || typeof ipcMain?.handle !== 'function') return;
  installed = true;

  // Validation happens inside each routed controller: `createController`
  // applies the environment default at every controller site.
  scope.add(
    exposeWireToWindows(
      { ipcMain, createMessageChannel },
      createLazyRoutingController({ followRemote: true }),
      {
        channel: DESKTOP_WIRE_CHANNEL,
      }
    )
  );
}

let remoteHub: WireSessionHub | undefined;
let nextRemoteSession = 0;

/**
 * Serves the same controllers as the window to a remote client (browser access): each
 * transport gets its own session. Returns a function that ends the session.
 */
export function openRemoteWireSession(transport: WireTransport): () => void {
  if (!remoteHub) {
    // Browsers served by this computer always get this computer's controllers, even
    // while its own window drives another one.
    remoteHub = createWireSessionHub(createLazyRoutingController({ followRemote: false }));
    const hub = remoteHub;
    scope.add(async () => {
      await hub.dispose();
    });
  }
  nextRemoteSession += 1;
  return remoteHub.open(`remote-${nextRemoteSession}`, transport);
}

/** Controllers answering for another computer this window drives; null for this one. */
let remoteRouting: Promise<Record<string, Controller> | null> = Promise.resolve(null);
/** The settled value of `remoteRouting`; undefined while it is pending. */
let settledRemote: Record<string, Controller> | null | undefined = null;
let mergedFor: { local: Record<string, Controller>; remote: Record<string, Controller> } | null =
  null;
let merged: Record<string, Controller> | null = null;

/**
 * Routes the window's traffic to another computer's controllers (the remote client),
 * or back to this one with null. Traffic waits while the promise is pending. Domains
 * the remote set omits (the local-only ones) keep answering here.
 */
export function setRemoteRouting(next: Promise<Record<string, Controller> | null>): void {
  remoteRouting = next;
  settledRemote = undefined;
  void next.then(
    (controllers) => {
      if (remoteRouting === next) settledRemote = controllers;
    },
    () => {
      if (remoteRouting === next) settledRemote = null;
    }
  );
}

function withRemote(
  local: Record<string, Controller>,
  remote: Record<string, Controller> | null
): Record<string, Controller> {
  if (!remote) return local;
  if (mergedFor?.local !== local || mergedFor.remote !== remote) {
    mergedFor = { local, remote };
    merged = { ...local, ...remote };
  }
  return merged!;
}

/** Provides the controllers bundle; releases any wire traffic queued so far. */
export function registerDesktopWireControllers(bundle: ControllersBundle): void {
  if (registeredControllers) return;
  registeredControllers = bundle.controllers;
  scope.add(() => bundle.scope.dispose());
  resolveControllers?.(bundle.controllers);
}

function createMessageChannel() {
  const channel = new MessageChannelMain();
  return { port1: channel.port1, port2: channel.port2 };
}

function createLazyRoutingController({ followRemote }: { followRemote: boolean }): Controller {
  const ready = (): Record<string, Controller> | null => {
    if (!registeredControllers) return null;
    if (!followRemote) return registeredControllers;
    return settledRemote === undefined ? null : withRemote(registeredControllers, settledRemote);
  };
  const whenReady = async (): Promise<Record<string, Controller>> => {
    const local = registeredControllers ?? (await controllersPromise);
    if (!followRemote) return local;
    return withRemote(local, await remoteRouting.catch(() => null));
  };
  return {
    async call(path, input, meta) {
      const routed = route(path, ready() ?? (await whenReady()));
      return await routed.controller.call(routed.path, input, meta);
    },
    resolveLive(topic) {
      const controllers = ready();
      if (controllers) {
        const routed = route(topic, controllers);
        return routed.controller.resolveLive(routed.path);
      }
      return deferredLiveSource(topic, whenReady);
    },
    acquireLive(topic) {
      const controllers = ready();
      if (controllers) {
        const routed = route(topic, controllers);
        return routed.controller.acquireLive(routed.path);
      }
      return deferredLiveLease(topic, whenReady);
    },
  };
}

/**
 * A live source for a topic requested before controllers registered: traffic
 * waits for registration and then delegates to the routed source. An unknown
 * topic surfaces as NOT_FOUND at first use, matching the routed behavior.
 */
function deferredLiveSource(
  topic: string,
  whenReady: () => Promise<Record<string, Controller>>
): LiveSource {
  const resolved = whenReady().then((controllers) => {
    const routed = route(topic, controllers);
    const source = routed.controller.resolveLive(routed.path);
    if (!source) throw new WireError('NOT_FOUND', `Unknown live topic '${topic}'`);
    return source;
  });
  resolved.catch(() => {});
  return {
    async snapshot() {
      return await (await resolved).snapshot();
    },
    async subscribe(cb, options) {
      return await (await resolved).subscribe(cb, options);
    },
  };
}

/**
 * Lease-style counterpart of {@link deferredLiveSource}. An unknown topic
 * surfaces as UNKNOWN_TOPIC, matching `requireLiveLease` in the wire server —
 * the two deferred variants intentionally mirror their routed counterparts'
 * error codes.
 */
function deferredLiveLease(
  topic: string,
  whenReady: () => Promise<Record<string, Controller>>
): PendingLease<LiveSource> {
  let inner: PendingLease<LiveSource> | null | undefined;
  const acquired = whenReady().then((controllers) => {
    const routed = route(topic, controllers);
    inner = routed.controller.acquireLive(routed.path);
    if (!inner) throw new WireError('UNKNOWN_TOPIC', `Unknown live topic '${topic}'`);
    return inner;
  });
  acquired.catch(() => {});
  return {
    ready: async () => await (await acquired).ready(),
    release: async () => {
      const lease = await acquired.catch(() => undefined);
      await lease?.release();
    },
  };
}

function route(path: string, controllers: Record<string, Controller>) {
  const [prefix, ...rest] = path.split('.');
  const controller = controllers[prefix];
  if (!controller || rest.length === 0) {
    throw new Error(`Unknown desktop wire path '${path}'`);
  }
  return { controller, path: rest.join('.') };
}
