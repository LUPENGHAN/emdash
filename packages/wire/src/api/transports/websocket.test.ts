import { describe, expect, it, vi } from 'vitest';
import type { WireMessage } from '../protocol';
import { webSocketTransport, type WebSocketLike } from './websocket';

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 1;
  peer: FakeSocket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  send(data: Uint8Array<ArrayBuffer>): void {
    // Browsers deliver a copy as an ArrayBuffer.
    const copy = data.slice().buffer;
    this.peer?.emit('message', { data: copy });
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
    if (this.peer && this.peer.readyState !== 3) this.peer.close();
  }

  addEventListener(event: string, cb: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  removeEventListener(event: string, cb: Listener): void {
    this.listeners.get(event)?.delete(cb);
  }

  emit(event: string, payload: { data?: unknown }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const left = new FakeSocket();
  const right = new FakeSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

describe('webSocketTransport', () => {
  it('carries JSON messages and blob chunks as binary frames', () => {
    const [leftSocket, rightSocket] = socketPair();
    const left = webSocketTransport(leftSocket);
    const right = webSocketTransport(rightSocket);
    const received: WireMessage[] = [];
    right.onMessage((message) => received.push(message));

    left.post({ kind: 'cancel', id: 'call-1' });
    left.post({
      kind: 'blob-chunk',
      channel: 'blob-1',
      seq: 0,
      data: new Uint8Array([1, 2, 255]),
    } as WireMessage);

    expect(leftSocket.binaryType).toBe('arraybuffer');
    expect(received[0]).toEqual({ kind: 'cancel', id: 'call-1' });
    expect(received[1]).toMatchObject({ kind: 'blob-chunk', channel: 'blob-1', seq: 0 });
    expect(Array.from((received[1] as { data: Uint8Array }).data)).toEqual([1, 2, 255]);
  });

  it('ignores malformed frames', () => {
    const [, rightSocket] = socketPair();
    const right = webSocketTransport(rightSocket);
    const onMessage = vi.fn();
    right.onMessage(onMessage);

    rightSocket.emit('message', { data: 'not binary' });
    rightSocket.emit('message', { data: new Uint8Array([0, 0, 0, 0, 9, 1]).buffer });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('reports a closed socket once and refuses to post afterwards', () => {
    const [leftSocket, rightSocket] = socketPair();
    const left = webSocketTransport(leftSocket);
    const onDisconnect = vi.fn();
    left.onDisconnect(onDisconnect);

    rightSocket.close();

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(() => left.post({ kind: 'cancel', id: 'x' })).toThrow('disconnected');
  });
});
