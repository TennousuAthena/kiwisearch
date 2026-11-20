import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveGroupKeys, deriveTopicId, generateRecoveryPhrase, importGroupSecret } from '@kiwi-search/sync';

const mockStorage = vi.hoisted(() => ({ record: null as unknown }));

vi.mock('../lib/syncDb', () => ({
  createDefaultSyncStorage: () => ({
    load: async () => mockStorage.record,
  }),
}));

import { SyncTransportCore, type TransportConfig } from '../lib/syncTransportCore';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }
}

function makeConfig(relayUrl = ''): TransportConfig {
  return {
    deviceId: 'device-a',
    deviceName: 'Device A',
    epoch: 1,
    relayUrl,
    stunEnabled: false,
    stunUrls: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
});

describe('SyncTransportCore', () => {
  it('does not tear down peers when started again with identical config', async () => {
    const keys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy));
    mockStorage.record = { groupKeys: keys };
    const events: unknown[] = [];
    const core = new SyncTransportCore((event) => events.push(event));
    const config = makeConfig();

    await core.start(config);
    const peers = (core as unknown as {
      peers: Map<string, { peerId: string; peerName: string; channel: 'webrtc'; connectedEmitted: boolean }>;
    }).peers;
    peers.set('peer-b', {
      peerId: 'peer-b',
      peerName: 'Peer B',
      channel: 'webrtc',
      connectedEmitted: true,
    });
    const stateEventCount = events.length;

    await core.start({ ...config });

    expect(events).toHaveLength(stateEventCount);
    expect(core.getReconnectSnapshot().peers.map((peer) => peer.peerId)).toEqual(['peer-b']);
  });

  it('reconnects to the new UTC-day topic with jitter and resends hello', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T23:59:59.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const keys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy));
    mockStorage.record = { groupKeys: keys };
    const core = new SyncTransportCore(() => {});

    await core.start(makeConfig('wss://relay.example'));
    FakeWebSocket.instances[0]?.open();
    await vi.advanceTimersByTimeAsync(0);
    const today = await deriveTopicId(keys.topicKey, '2026-11-20');
    const tomorrow = await deriveTopicId(keys.topicKey, '2026-11-21');
    expect(FakeWebSocket.instances[0]?.url).toContain(today);
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]?.send).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.url).toContain(tomorrow);
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    expect((core as unknown as { ws: FakeWebSocket | null }).ws).toBe(reconnectedSocket);
    reconnectedSocket.open();
    await vi.waitFor(() => expect(reconnectedSocket.send).toHaveBeenCalled());
    core.stop();
  });
});
