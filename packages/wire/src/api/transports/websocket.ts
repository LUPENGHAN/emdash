import type { Unsubscribe } from '@emdash/shared';
import type { WireMessage, WireTransport } from '../protocol';
import { decodeWireFrame, encodeWireFrame } from './stream';

const OPEN = 1;

/**
 * The part of a WebSocket the transport needs: the browser `WebSocket` and the `ws`
 * package's socket both fit.
 */
export type WebSocketLike = {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(event: string, cb: (event: { data?: unknown }) => void): void;
  removeEventListener?(event: string, cb: (event: { data?: unknown }) => void): void;
};

/**
 * Wire over a WebSocket: each message is one binary frame in the stream transport's
 * format, so blob chunks keep their bytes. The socket should already be open.
 */
export function webSocketTransport(socket: WebSocketLike): WireTransport {
  const messageListeners = new Set<(message: WireMessage) => void>();
  const disconnectListeners = new Set<() => void>();
  let disconnected = false;
  socket.binaryType = 'arraybuffer';

  const notifyDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    for (const listener of disconnectListeners) listener();
  };
  const onMessage = (event: { data?: unknown }): void => {
    const bytes = toBytes(event.data);
    const message = bytes ? decodeWireFrame(bytes) : null;
    if (!message) return;
    for (const listener of messageListeners) listener(message);
  };

  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', notifyDisconnect);
  socket.addEventListener('error', notifyDisconnect);
  if (socket.readyState > OPEN) notifyDisconnect();

  return {
    post(message) {
      if (disconnected || socket.readyState !== OPEN) {
        throw new Error('WebSocket transport disconnected');
      }
      socket.send(encodeWireFrame(message));
    },
    onMessage(cb): Unsubscribe {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onDisconnect(cb): Unsubscribe {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
    close() {
      socket.removeEventListener?.('message', onMessage);
      socket.removeEventListener?.('close', notifyDisconnect);
      socket.removeEventListener?.('error', notifyDisconnect);
      messageListeners.clear();
      disconnectListeners.clear();
      disconnected = true;
      socket.close();
    },
  };
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
