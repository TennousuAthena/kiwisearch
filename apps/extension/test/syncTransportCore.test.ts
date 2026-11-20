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
  PREVIOUS_GROUP_SECRET_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1_000,
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
  send = vi.fn((_data: unknown) => {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket is not open');
  });

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

  addIceCandidate = vi.fn(async () => {});

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
    legacyEpochs: [],
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
  payload: {
    t: string;
    from: string;
    fromName?: string;
    epoch?: number;
    certHash?: string;
    offerId?: string;
    re?: string;
    sdp?: string;
    candidate?: RTCIceCandidateInit;
  },
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
      peers: Map<string, { peerId: string; epoch: number; peerName: string; channel: 'webrtc'; connectedEmitted: boolean }>;
    }).peers;
    peers.set('peer-b', {
      peerId: 'peer-b',
      epoch: 1,
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

  it('drops a relay frame when the socket closes during sealing', async () => {
    const { core, keys, ws } = await createRelayCore();
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let releaseSeal = () => {};
    const sealPending = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    let markSealStarted = () => {};
    const sealStarted = new Promise<void>((resolve) => {
      markSealStarted = resolve;
    });
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      markSealStarted();
      await sealPending;
      return originalEncrypt(algorithm, key, data);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendSignal = (
      core as unknown as {
        sendSignal: (message: { t: string; from: string; epoch: number }) => Promise<void>;
      }
    ).sendSignal.bind(core);
    const sendsBefore = ws.send.mock.calls.length;
    const send = sendSignal({ t: 'hello', from: 'device-a', epoch: keys.epoch });

    await sealStarted;
    ws.close();
    releaseSeal();

    await expect(send).resolves.toBeUndefined();
    expect(ws.send).toHaveBeenCalledTimes(sendsBefore);
    expect(consoleError).not.toHaveBeenCalled();
    core.stop();
  });

  it('opens a relay-only beacon for a retained epoch and sends with its keys', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
    const previousSecret = await importGroupSecret(new Uint8Array(32).fill(2));
    const currentSecret = await importGroupSecret(new Uint8Array(32).fill(3));
    const previousKeys = await deriveGroupKeys(previousSecret, 2);
    const currentKeys = await deriveGroupKeys(currentSecret, 3);
    mockStorage.record = {
      groupKeys: currentKeys,
      previousGroupSecrets: [{ epoch: 2, secret: previousSecret, rotatedAt: Date.now() }],
    };
    const events: import('../lib/syncTransportCore').TransportEvent[] = [];
    const core = new SyncTransportCore((event) => events.push(event));

    await core.start({ ...makeConfig('wss://relay.example'), epoch: 3, legacyEpochs: [2] });

    expect(FakeWebSocket.instances).toHaveLength(2);
    const currentWs = FakeWebSocket.instances[0]!;
    const legacyWs = FakeWebSocket.instances[1]!;
    currentWs.open();
    legacyWs.open();
    await vi.waitFor(() => expect(legacyWs.send).toHaveBeenCalled());

    await receiveRelaySignal(legacyWs, previousKeys, {
      t: 'hello',
      from: 'device-z',
      fromName: 'Device Z',
      epoch: 2,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'peer-connected', peerId: 'device-z', epoch: 2, channel: 'relay' }),
      ),
    );
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    expect(await core.sendToPeer('device-z', '{"type":"vv"}', 2)).toBe(true);
    const legacySignals = await readSentSignals(legacyWs, previousKeys);
    expect(legacySignals).toContainEqual(expect.objectContaining({ t: 'relay-data', to: 'device-z' }));

    await core.start({ ...makeConfig('wss://relay.example'), epoch: 3, legacyEpochs: [] });
    expect(legacyWs.readyState).toBe(FakeWebSocket.CLOSED);
    core.stop();
  });

  it('announces authenticated legacy peers when their relay socket reconnects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const previousSecret = await importGroupSecret(new Uint8Array(32).fill(7));
    const currentSecret = await importGroupSecret(new Uint8Array(32).fill(8));
    const previousKeys = await deriveGroupKeys(previousSecret, 2);
    const currentKeys = await deriveGroupKeys(currentSecret, 3);
    mockStorage.record = {
      groupKeys: currentKeys,
      previousGroupSecrets: [{ epoch: 2, secret: previousSecret, rotatedAt: Date.now() }],
    };
    const events: import('../lib/syncTransportCore').TransportEvent[] = [];
    const core = new SyncTransportCore((event) => events.push(event));
    await core.start({ ...makeConfig('wss://relay.example'), epoch: 3, legacyEpochs: [2] });

    const oldLegacySocket = FakeWebSocket.instances[1]!;
    oldLegacySocket.open();
    await receiveRelaySignal(oldLegacySocket, previousKeys, {
      t: 'hello',
      from: 'device-z',
      epoch: 2,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'peer-connected', peerId: 'device-z', epoch: 2 }),
      ),
    );
    oldLegacySocket.close();
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() =>
      expect(
        FakeWebSocket.instances.some((socket) => socket !== oldLegacySocket && socket.url === oldLegacySocket.url),
      ).toBe(true),
    );
    const reconnectedSocket = FakeWebSocket.instances.find(
      (socket) => socket !== oldLegacySocket && socket.url === oldLegacySocket.url,
    )!;
    reconnectedSocket.open();
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'peer-channel',
        peerId: 'device-z',
        epoch: 2,
        channel: 'relay',
      }),
    );
    core.stop();
  });

  it('rolls a retained legacy topic at UTC midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T23:59:50.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const previousSecret = await importGroupSecret(new Uint8Array(32).fill(11));
    const currentSecret = await importGroupSecret(new Uint8Array(32).fill(12));
    const previousKeys = await deriveGroupKeys(previousSecret, 2);
    const currentKeys = await deriveGroupKeys(currentSecret, 3);
    mockStorage.record = {
      groupKeys: currentKeys,
      previousGroupSecrets: [{ epoch: 2, secret: previousSecret, rotatedAt: Date.now() }],
    };
    const core = new SyncTransportCore(() => {});
    await core.start({ ...makeConfig('wss://relay.example'), epoch: 3, legacyEpochs: [2] });
    const oldLegacySocket = FakeWebSocket.instances[1]!;
    oldLegacySocket.open();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(oldLegacySocket.readyState).toBe(FakeWebSocket.CLOSED);
    const legacyTopicId = await deriveTopicId(previousKeys.topicKey, '2026-11-21');
    const currentTopicId = await deriveTopicId(currentKeys.topicKey, '2026-11-21');
    await vi.waitFor(() =>
      expect(
        FakeWebSocket.instances.some((socket) => socket.url.includes(legacyTopicId)) &&
          FakeWebSocket.instances.some((socket) => socket.url.includes(currentTopicId)),
      ).toBe(true),
    );
    expect(FakeWebSocket.instances.filter((socket) => socket.url.includes(currentTopicId))).toHaveLength(1);
    expect(FakeWebSocket.instances.filter((socket) => socket.url.includes(legacyTopicId))).toHaveLength(1);
    core.stop();
  });

  it('closes an expired legacy beacon after the 30-day retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const previousSecret = await importGroupSecret(new Uint8Array(32).fill(4));
    const currentSecret = await importGroupSecret(new Uint8Array(32).fill(5));
    const previousKeys = await deriveGroupKeys(previousSecret, 2);
    const currentKeys = await deriveGroupKeys(currentSecret, 3);
    mockStorage.record = {
      groupKeys: currentKeys,
      previousGroupSecrets: [
        {
          epoch: 2,
          secret: previousSecret,
          rotatedAt: Date.now() - 30 * 24 * 60 * 60 * 1_000 + 500,
        },
      ],
    };
    const core = new SyncTransportCore(() => {});

    await core.start({ ...makeConfig('wss://relay.example'), epoch: 3, legacyEpochs: [2] });
    const legacyWs = FakeWebSocket.instances[1]!;
    expect(legacyWs).toBeDefined();

    await vi.advanceTimersByTimeAsync(501);

    expect(legacyWs.readyState).toBe(FakeWebSocket.CLOSED);
    core.stop();
  });

  it('expires an idle relay peer after 90 seconds with bounded hello keepalives', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('RTCPeerConnection', undefined);
    const keys = await deriveGroupKeys(await importGroupSecret(new Uint8Array(32).fill(6)));
    mockStorage.record = { groupKeys: keys };
    const events: import('../lib/syncTransportCore').TransportEvent[] = [];
    const core = new SyncTransportCore((event) => events.push(event));

    await core.start(makeConfig('wss://relay.example'));
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', epoch: 1 });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'peer-connected', peerId: 'device-b', epoch: 1, channel: 'relay' }),
      ),
    );

    const lastSeenAt = (core as unknown as { peers: Map<string, { lastSeenAt: number }> }).peers.get('device-b')!
      .lastSeenAt;
    const remainingMs = 90_000 - (Date.now() - lastSeenAt);
    await vi.advanceTimersByTimeAsync(remainingMs - 1);
    expect(events).not.toContainEqual({ type: 'peer-disconnected', peerId: 'device-b', epoch: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(events).toContainEqual({ type: 'peer-disconnected', peerId: 'device-b', epoch: 1 });
    const helloCount = (await readSentSignals(ws, keys)).filter((signal) => signal.t === 'hello').length;
    expect(helloCount).toBeLessThanOrEqual(6);
    core.stop();
  });

  it('expires an idle peer on a legacy relay socket after 90 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('RTCPeerConnection', undefined);
    const previousSecret = await importGroupSecret(new Uint8Array(32).fill(9));
    const currentSecret = await importGroupSecret(new Uint8Array(32).fill(10));
    const previousKeys = await deriveGroupKeys(previousSecret, 2);
    const currentKeys = await deriveGroupKeys(currentSecret, 3);
    mockStorage.record = {
      groupKeys: currentKeys,
      previousGroupSecrets: [{ epoch: 2, secret: previousSecret, rotatedAt: Date.now() }],
    };
    const events: import('../lib/syncTransportCore').TransportEvent[] = [];
    const core = new SyncTransportCore((event) => events.push(event));
    await core.start({ ...makeConfig('wss://relay.example'), epoch: 3, legacyEpochs: [2] });
    const ws = FakeWebSocket.instances[1]!;
    ws.open();
    await receiveRelaySignal(ws, previousKeys, { t: 'hello', from: 'device-z', epoch: 2 });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'peer-connected', peerId: 'device-z', epoch: 2, channel: 'relay' }),
      ),
    );

    const lastSeenAt = (
      core as unknown as { legacyPeers: Map<number, Map<string, { lastSeenAt: number }>> }
    ).legacyPeers.get(2)!.get('device-z')!.lastSeenAt;
    const remainingMs = 90_000 - (Date.now() - lastSeenAt);
    await vi.advanceTimersByTimeAsync(remainingMs - 1);
    expect(events).not.toContainEqual({ type: 'peer-disconnected', peerId: 'device-z', epoch: 2 });
    await vi.advanceTimersByTimeAsync(1);

    expect(events).toContainEqual({ type: 'peer-disconnected', peerId: 'device-z', epoch: 2 });
    const helloCount = (await readSentSignals(ws, previousKeys)).filter((signal) => signal.t === 'hello').length;
    expect(helloCount).toBeLessThanOrEqual(6);
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
    expect(events).toContainEqual({ type: 'peer-disconnected', peerId: 'device-b', epoch: 1 });
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

  it('keeps the peer on relay fallback when its direct data channel closes', async () => {
    const { core, events, keys, ws } = await createRelayCore();
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: 'bc:07:82' });
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const pc = FakeRTCPeerConnection.instances[0]!;
    const dc = FakeRTCPeerConnection.instances[0]!.dataChannels[0]!;
    dc.open();
    const helloCount = async () => (await readSentSignals(ws, keys)).filter((signal) => signal.t === 'hello').length;
    const previousHelloCount = await helloCount();
    dc.close();

    const slots = (core as unknown as { peers: Map<string, { channel: string; connectedEmitted: boolean }> }).peers;
    expect(pc.closed).toBe(true);
    expect(slots.get('device-b')).toMatchObject({ channel: 'relay', connectedEmitted: true });
    expect(events).toContainEqual({ type: 'peer-channel', peerId: 'device-b', epoch: 1, channel: 'relay' });
    expect(events).not.toContainEqual({ type: 'peer-disconnected', peerId: 'device-b', epoch: 1 });
    expect(await helloCount()).toBe(previousHelloCount);
    core.stop();
  });

  it('preserves a connected relay fallback when the direct peer connection fails', async () => {
    const { core, events, keys, ws } = await createRelayCore();
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-b', fromName: 'Peer B', certHash: 'bc:07:82' });
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const pc = FakeRTCPeerConnection.instances[0]!;
    pc.dataChannels[0]!.open();

    pc.setConnectionState('failed');

    const slots = (core as unknown as {
      peers: Map<string, { channel: string; connectedEmitted: boolean; pc: RTCPeerConnection | null }>;
    }).peers;
    expect(slots.get('device-b')).toMatchObject({ channel: 'relay', connectedEmitted: true, pc: null });
    expect(pc.closed).toBe(true);
    expect(events).toContainEqual({ type: 'peer-channel', peerId: 'device-b', epoch: 1, channel: 'relay' });
    expect(events).not.toContainEqual({ type: 'peer-disconnected', peerId: 'device-b', epoch: 1 });
    core.stop();
  });

  it('keeps queued ICE candidates for the matching offer that arrives later', async () => {
    const { core, keys, ws } = await createRelayCore();
    await receiveRelaySignal(ws, keys, { t: 'hello', from: 'device-0', fromName: 'Peer 0', certHash: 'peer-fp' });
    await receiveRelaySignal(ws, keys, {
      t: 'ice',
      from: 'device-0',
      certHash: 'peer-fp',
      re: 'offer-123',
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' },
    });
    await receiveRelaySignal(ws, keys, {
      t: 'offer',
      from: 'device-0',
      fromName: 'Peer 0',
      certHash: 'peer-fp',
      offerId: 'offer-123',
      sdp: 'a=fingerprint:sha-256 AA:BB:CC\r\n',
    });

    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const pc = FakeRTCPeerConnection.instances[0]!;
    expect(pc.remoteDescription?.type).toBe('offer');
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' });
    core.stop();
  });
});
