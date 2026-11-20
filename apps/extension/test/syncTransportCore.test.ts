import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveGroupKeys,
  deriveTopicId,
  generateRecoveryPhrase,
  importGroupSecret,
  openRelayFrame,
  sealRelayFrame,
  type GroupKeys,
} from '@kiwi-search/sync';

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
  send = vi.fn((_data: unknown) => {});

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

  receive(frame: Uint8Array): void {
    const data = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  send = vi.fn((_data: string) => {});

  open(): void {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }

  close(): void {
    this.readyState = 'closed';
    this.onclose?.(new Event('close'));
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  static generateCertificate = vi.fn(async () => ({
    expires: Date.now() + 2 * 60 * 60 * 1_000,
    getFingerprints: () => [{ algorithm: 'sha-256', value: 'aa:bb:cc' }],
  }) as unknown as RTCCertificate);

  readonly dataChannels: FakeDataChannel[] = [];
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: ((event: Event) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  closed = false;
  restartIce = vi.fn();

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    const dataChannel = new FakeDataChannel();
    this.dataChannels.push(dataChannel);
    return dataChannel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'a=fingerprint:sha-256 AA:BB:CC\r\n' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'a=fingerprint:sha-256 AA:BB:CC\r\n' };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (!description) return;
    this.localDescription = description as RTCSessionDescription;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(): Promise<void> {}

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }

  close(): void {
    this.closed = true;
    this.setConnectionState('closed');
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

async function createRelayCore() {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
  const keys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy));
  mockStorage.record = { groupKeys: keys };
  const events: import('../lib/syncTransportCore').TransportEvent[] = [];
  const core = new SyncTransportCore((event) => events.push(event));
  await core.start(makeConfig('wss://relay.example'));
  const ws = FakeWebSocket.instances[0]!;
  ws.open();
  await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
  return { core, events, keys, ws };
}

async function receiveRelaySignal(
  ws: FakeWebSocket,
  keys: GroupKeys,
  payload: { t: string; from: string; fromName?: string; epoch?: number; certHash?: string },
): Promise<void> {
  const frame = await sealRelayFrame(keys, {
    id: crypto.randomUUID(),
    ts: Date.now(),
    payload: { epoch: 1, ...payload },
  });
  ws.receive(frame);
}

async function readSentSignals(ws: FakeWebSocket, keys: GroupKeys): Promise<Array<{ t: string; to?: string }>> {
  return Promise.all(
    ws.send.mock.calls.map(async ([frame]) => {
      const opened = await openRelayFrame<{ payload: { t: string; to?: string } }>(keys, frame as Uint8Array);
      return opened.payload;
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
  FakeRTCPeerConnection.instances = [];
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

  it('replaces a peer slot when a relay hello carries a changed certificate', async () => {
    const { core, events, keys, ws } = await createRelayCore();
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: 'bc:07:82' });
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const oldPc = FakeRTCPeerConnection.instances[0]!;
    const oldDc = oldPc.dataChannels[0]!;
    oldDc.open();

    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: '36:0a:50' });
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(2));

    const slots = (core as unknown as { peers: Map<string, { peerCertHash: string; pc: RTCPeerConnection | null }> }).peers;
    const slot = slots.get('device-b');
    expect(oldPc.closed).toBe(true);
    expect(oldDc.readyState).toBe('closed');
    expect(slot?.peerCertHash).toBe('36:0a:50');
    expect(slot?.pc).toBe(FakeRTCPeerConnection.instances[1]);
    expect(events).toContainEqual({ type: 'peer-disconnected', peerId: 'device-b' });
    core.stop();
  });

  it('keeps a healthy peer slot for a duplicate hello with the same certificate', async () => {
    const { core, events, keys, ws } = await createRelayCore();
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: 'bc:07:82' });
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const pc = FakeRTCPeerConnection.instances[0]!;
    const dc = pc.dataChannels[0]!;
    dc.open();
    const disconnectedEvents = events.filter((event) => event.type === 'peer-disconnected').length;
    const previousSendCalls = ws.send.mock.calls.length;

    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: 'bc:07:82' });
    await vi.waitFor(() => expect(ws.send.mock.calls.length).toBeGreaterThan(previousSendCalls));

    const slots = (core as unknown as { peers: Map<string, { pc: RTCPeerConnection | null; dc: RTCDataChannel | null }> }).peers;
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(slots.get('device-b')?.pc).toBe(pc);
    expect(slots.get('device-b')?.dc).toBe(dc);
    expect(dc.readyState).toBe('open');
    expect(events.filter((event) => event.type === 'peer-disconnected')).toHaveLength(disconnectedEvents);
    core.stop();
  });

  it('removes a peer slot and sends a relay hello when its data channel closes', async () => {
    const { core, events, keys, ws } = await createRelayCore();
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: 'bc:07:82' });
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const dc = FakeRTCPeerConnection.instances[0]!.dataChannels[0]!;
    dc.open();
    const helloCount = async () => (await readSentSignals(ws, keys)).filter((signal) => signal.t === 'hello').length;
    const previousHelloCount = await helloCount();

    dc.close();
    await vi.waitFor(async () => expect(await helloCount()).toBe(previousHelloCount + 1));

    const slots = (core as unknown as { peers: Map<string, unknown> }).peers;
    const signals = await readSentSignals(ws, keys);
    expect(events).toContainEqual({ type: 'peer-disconnected', peerId: 'device-b' });
    expect(slots.has('device-b')).toBe(false);
    expect(signals.at(-1)).toMatchObject({ t: 'hello' });
    expect(signals.at(-1)?.to).toBeUndefined();
    core.stop();
  });
});
