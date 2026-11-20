import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReconnectingPortClient, type ReconnectingPort } from '../lib/syncTransportPort';

class FakePort implements ReconnectingPort {
  readonly sent: unknown[] = [];
  private messageListeners: Array<(message: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  onMessage = {
    addListener: (listener: (message: unknown) => void) => this.messageListeners.push(listener),
  };

  onDisconnect = {
    addListener: (listener: () => void) => this.disconnectListeners.push(listener),
  };

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ReconnectingPortClient', () => {
  it('reconnects with backoff, bounds the outgoing buffer, and requests a snapshot', () => {
    vi.useFakeTimers();
    const ports: FakePort[] = [];
    const client = new ReconnectingPortClient({
      connect: () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      onMessage: () => {},
      onReconnect: (port) => port.postMessage({ kind: 'snapshot' }),
      maxBufferedMessages: 2,
      baseDelayMs: 50,
      maxDelayMs: 100,
    });

    client.start();
    expect(ports[0]?.sent).toEqual([{ kind: 'snapshot' }]);
    ports[0]!.disconnect();
    client.postMessage('dropped');
    client.postMessage('buffered-1');
    client.postMessage('buffered-2');
    vi.advanceTimersByTime(50);

    expect(ports).toHaveLength(2);
    expect(ports[1]?.sent).toEqual([
      'buffered-1',
      'buffered-2',
      { kind: 'snapshot' },
    ]);
    ports[1]!.disconnect();
    vi.advanceTimersByTime(99);
    expect(ports).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(3);

    client.stop();
  });
});
