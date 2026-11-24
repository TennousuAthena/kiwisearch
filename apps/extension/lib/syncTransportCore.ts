import {
  ReplayGuard,
  decodeConnectionCode,
  deriveGroupKeys,
  deriveTopicId,
  encodeConnectionCode,
  openRelayFrame,
  sealRelayFrame,
  type CompactIceCandidate,
  type GroupKeys,
  utcDayString,
} from '@kiwi-search/sync';
import type { SyncPeerChannel, SyncTransportState } from '@kiwi-search/protocol';
import {
  createDefaultSyncStorage,
  PREVIOUS_GROUP_SECRET_MAX_AGE_MS,
  type PreviousGroupSecret,
} from './syncDb';

export interface TransportConfig {
  deviceId: string;
  deviceName: string;
  epoch: number;
  relayUrl: string;
  stunEnabled: boolean;
  stunUrls: string[];
  legacyEpochs: number[];
}

export type TransportEvent =
  | { type: 'state'; state: SyncTransportState; error?: string }
  | {
      type: 'snapshot';
      state: SyncTransportState;
      error?: string;
      peers: Array<{
        peerId: string;
        epoch: number;
        peerName: string;
        channel: SyncPeerChannel;
        ownCertHash: string;
        peerCertHash: string;
      }>;
    }
  | {
      type: 'peer-connected';
      peerId: string;
      epoch: number;
      peerName: string;
      channel: SyncPeerChannel;
      ownCertHash: string;
      peerCertHash: string;
    }
  | { type: 'peer-disconnected'; peerId: string; epoch: number }
  | { type: 'peer-channel'; peerId: string; epoch: number; channel: SyncPeerChannel }
  | { type: 'peer-message'; peerId: string; epoch: number; payload: string };

interface SignalEnvelope {
  t: 'hello' | 'offer' | 'answer' | 'ice' | 'bye' | 'relay-data';
  relayFallback?: true;
  from: string;
  fromName?: string;
  to?: string;
  epoch: number;
  certHash?: string;
  offerId?: string;
  re?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  msgId?: string;
  idx?: number;
  total?: number;
  chunk?: string;
}

interface PeerSlot {
  peerId: string;
  epoch: number;
  peerName: string;
  peerCertHash: string;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  offerId: string | null;
  channel: SyncPeerChannel;
  connectedEmitted: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  disconnectedTimer: ReturnType<typeof setTimeout> | null;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  lastSeenAt: number;
  pendingIce: Array<{ offerId: string | null; candidate: RTCIceCandidateInit }>;
  restartedIce: boolean;
}

const WEBRTC_FALLBACK_TIMEOUT_MS = 6_000;
const PEER_DISCONNECTED_TIMEOUT_MS = 5_000;
const RELAY_KEEPALIVE_MS = 30_000;
const RELAY_PEER_EXPIRY_MS = 90_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const RELAY_CHUNK_CHARS = 9_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const MIDNIGHT_JITTER_MAX_MS = 30_000;

function normalizeRelayWsUrl(relayUrl: string, topicId: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, '');
  const wsUrl = trimmed.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  return `${wsUrl}/v1/${topicId}`;
}

function extractSdpFingerprint(sdp: string | undefined): string {
  if (!sdp) return '';
  const match = sdp.match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/);
  return match ? match[1]!.toLowerCase() : '';
}

function extractSdpIceCredentials(sdp: string): { ufrag: string; pwd: string; fingerprint: string } {
  const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1]?.trim() ?? '';
  const pwd = sdp.match(/a=ice-pwd:([^\r\n]+)/)?.[1]?.trim() ?? '';
  const fingerprint = extractSdpFingerprint(sdp);
  return { ufrag, pwd, fingerprint };
}

function parseCandidateString(candidate: string): CompactIceCandidate | null {
  const parts = candidate.trim().split(/\s+/);
  // candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type>
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  const protocol = parts[2]?.toLowerCase() === 'tcp' ? 'tcp' : 'udp';
  const address = parts[4]!;
  const port = Number(parts[5]);
  const type = parts[7];
  if (!address || !Number.isFinite(port)) return null;
  if (type !== 'host' && type !== 'srflx') return null;
  return { address, port, type, protocol };
}

function buildCompactSdp(params: {
  ufrag: string;
  pwd: string;
  fingerprint: string;
  candidates: readonly CompactIceCandidate[];
  setup: 'actpass' | 'active';
}): string {
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${params.ufrag}`,
    `a=ice-pwd:${params.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${params.fingerprint.toUpperCase()}`,
    `a=setup:${params.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  params.candidates.forEach((c, idx) => {
    lines.push(`a=candidate:${idx + 1} 1 ${c.protocol ?? 'udp'} ${2122260223 - idx} ${c.address} ${c.port} typ ${c.type}`);
  });
  return `${lines.join('\r\n')}\r\n`;
}

export class SyncTransportCore {
  private config: TransportConfig | null = null;
  private groupKeys: GroupKeys | null = null;
  private certificate: RTCCertificate | null = null;
  private ownCertHash = '';
  private ws: WebSocket | null = null;
  private legacyGroupKeys = new Map<number, GroupKeys>();
  private legacyRotatedAt = new Map<number, number>();
  private legacySockets = new Map<number, WebSocket>();
  private replayGuard = new ReplayGuard();
  private peers = new Map<string, PeerSlot>();
  private legacyPeers = new Map<number, Map<string, PeerSlot>>();
  private relayChunks = new Map<string, { total: number; parts: string[]; createdAt: number }>();
  private legacyRelayChunks = new Map<string, { total: number; parts: string[]; createdAt: number }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyReconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private legacyMidnightTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private legacyExpiryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private legacyReconnectAttempts = new Map<number, number>();
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = true;
  private transportState: SyncTransportState = 'idle';
  private transportError: string | undefined;
  private manualOfferSlot: { pc: RTCPeerConnection; dc: RTCDataChannel; peerId: string } | null = null;

  constructor(private readonly onEvent: (event: TransportEvent) => void) {}

  private emit(event: TransportEvent): void {
    if (event.type === 'state') {
      this.transportState = event.state;
      this.transportError = event.error;
    }
    try {
      this.onEvent(event);
    } catch {
      // ignore listener errors
    }
  }

  private async ensureKeysAndCertificate(config = this.config): Promise<GroupKeys> {
    const storage = createDefaultSyncStorage();
    const record = await storage.load();
    if (!record) throw new Error('Sync group is not configured');
    this.groupKeys = record.groupKeys;
    this.legacyGroupKeys.clear();
    this.legacyRotatedAt.clear();
    const retainedSecrets: readonly PreviousGroupSecret[] = record.previousGroupSecrets ?? [];
    for (const epoch of new Set(config?.legacyEpochs ?? [])) {
      if (epoch === record.groupKeys.epoch) continue;
      const previous = retainedSecrets.find((entry) => entry.epoch === epoch);
      if (!previous || Date.now() - previous.rotatedAt > PREVIOUS_GROUP_SECRET_MAX_AGE_MS) continue;
      this.legacyGroupKeys.set(epoch, await deriveGroupKeys(previous.secret, epoch));
      this.legacyRotatedAt.set(epoch, previous.rotatedAt);
    }

    if (!this.certificate) {
      if (record.certificate && record.certificate.expires > Date.now() + 3600_000) {
        this.certificate = record.certificate;
      } else if (typeof RTCPeerConnection !== 'undefined' && typeof RTCPeerConnection.generateCertificate === 'function') {
        this.certificate = await RTCPeerConnection.generateCertificate({
          name: 'ECDSA',
          namedCurve: 'P-256',
        } as EcKeyGenParams);
      }
    }
    if (this.certificate && typeof this.certificate.getFingerprints === 'function') {
      const fp = this.certificate.getFingerprints().find((f) => f.algorithm?.toLowerCase() === 'sha-256');
      if (fp?.value) this.ownCertHash = fp.value.toLowerCase();
    }
    if (!this.ownCertHash) this.ownCertHash = config?.deviceId ?? 'kiwi-sync';
    return this.groupKeys;
  }

  async start(config: TransportConfig): Promise<void> {
    if (!this.stopped && this.config && JSON.stringify(this.config) === JSON.stringify(config)) return;
    const previousConfig = this.config;
    const previousKeys = this.groupKeys;
    const transportSettingsMatch =
      !this.stopped &&
      previousConfig &&
      previousConfig.deviceId === config.deviceId &&
      previousConfig.relayUrl === config.relayUrl &&
      previousConfig.stunEnabled === config.stunEnabled &&
      JSON.stringify(previousConfig.stunUrls) === JSON.stringify(config.stunUrls);
    if (transportSettingsMatch && previousKeys) {
      const previousTopicId = await deriveTopicId(previousKeys.topicKey);
      try {
        await this.ensureKeysAndCertificate(config);
      } catch (error) {
        this.groupKeys = previousKeys;
        this.emit({ type: 'state', state: 'error', error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const nextTopicId = await deriveTopicId(this.groupKeys!.topicKey);
      if (previousTopicId === nextTopicId) {
        this.config = config;
        if (previousConfig.epoch !== config.epoch) this.rebindCurrentPeerEpoch(config.epoch);
        if (
          this.ws?.readyState === WebSocket.OPEN &&
          (previousConfig.epoch !== config.epoch || previousConfig.deviceName !== config.deviceName)
        ) {
          await this.sendSignal({
            t: 'hello',
            from: config.deviceId,
            fromName: config.deviceName,
            epoch: config.epoch,
            certHash: this.ownCertHash,
          });
        }
        await this.reconcileLegacySockets();
        return;
      }
      this.groupKeys = previousKeys;
    }
    this.stop();
    this.config = config;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.replayGuard = new ReplayGuard();

    try {
      await this.ensureKeysAndCertificate(config);
    } catch (error) {
      this.emit({ type: 'state', state: 'error', error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (!config.relayUrl.trim()) {
      this.emit({ type: 'state', state: 'idle' });
      return;
    }

    await this.connectWebSocket();
    await this.reconcileLegacySockets();
    this.scheduleRelayKeepalives();
  }

  private rebindCurrentPeerEpoch(epoch: number): void {
    for (const slot of this.peers.values()) {
      if (slot.epoch === epoch) continue;
      const previousEpoch = slot.epoch;
      const wasConnected = slot.connectedEmitted;
      slot.epoch = epoch;
      if (!wasConnected) continue;
      this.emit({ type: 'peer-disconnected', peerId: slot.peerId, epoch: previousEpoch });
      this.emit({
        type: 'peer-connected',
        peerId: slot.peerId,
        epoch,
        peerName: slot.peerName,
        channel: slot.channel,
        ownCertHash: this.ownCertHash,
        peerCertHash: slot.peerCertHash || this.ownCertHash,
      });
      this.refreshRelayPresence(slot);
    }
  }

  getReconnectSnapshot(): Extract<TransportEvent, { type: 'snapshot' }> {
    return {
      type: 'snapshot',
      state: this.transportState,
      error: this.transportError,
      peers: [
        ...this.peers.values(),
        ...[...this.legacyPeers.values()].flatMap((peers) => [...peers.values()]),
      ]
        .filter((slot) => slot.connectedEmitted)
        .map((slot) => ({
          peerId: slot.peerId,
          epoch: slot.epoch,
          peerName: slot.peerName,
          channel: slot.channel,
          ownCertHash: this.ownCertHash,
          peerCertHash: slot.peerCertHash,
        })),
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.config && this.groupKeys) {
      void this.sendSignal({
        t: 'bye',
        from: this.config.deviceId,
        epoch: this.config.epoch,
      }).catch(() => {});
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'stop');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const slot of this.peers.values()) {
      this.cleanupPeerSlot(slot, true);
    }
    this.peers.clear();
    for (const epoch of [...this.legacySockets.keys(), ...this.legacyPeers.keys()]) {
      this.closeLegacyEpoch(epoch);
    }
    for (const timer of this.legacyReconnectTimers.values()) clearTimeout(timer);
    this.legacyReconnectTimers.clear();
    for (const timer of this.legacyMidnightTimers.values()) clearTimeout(timer);
    this.legacyMidnightTimers.clear();
    for (const timer of this.legacyExpiryTimers.values()) clearTimeout(timer);
    this.legacyExpiryTimers.clear();
    this.legacyReconnectAttempts.clear();
    this.legacyGroupKeys.clear();
    this.legacyRotatedAt.clear();
    this.relayChunks.clear();
    this.legacyRelayChunks.clear();
    if (this.manualOfferSlot) {
      try {
        this.manualOfferSlot.pc.close();
      } catch {
        // ignore
      }
      this.manualOfferSlot = null;
    }
    this.emit({ type: 'state', state: 'idle' });
  }

  private async connectWebSocket(): Promise<void> {
    if (this.stopped || !this.config || !this.groupKeys) return;
    this.emit({ type: 'state', state: 'connecting' });

    const topicId = await deriveTopicId(this.groupKeys.topicKey);
    const url = normalizeRelayWsUrl(this.config.relayUrl, topicId);
    this.scheduleMidnightRollover();

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      this.reconnectAttempts = 0;
      this.emit({ type: 'state', state: 'connected' });
      this.scheduleRelayKeepalives();
      void this.sendSignal({
        t: 'hello',
        from: this.config!.deviceId,
        fromName: this.config!.deviceName,
        epoch: this.config!.epoch,
        certHash: this.ownCertHash,
      });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.stopped) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      void this.handleRelayFrame(new Uint8Array(event.data));
    };

    ws.onerror = () => {
      if (this.ws !== ws || this.stopped) return;
      this.emit({ type: 'state', state: 'offline', error: 'Relay connection error' });
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.emit({ type: 'state', state: 'offline' });
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connectWebSocket();
      }, delay);
    };
  }

  private async reconcileLegacySockets(): Promise<void> {
    if (!this.config?.relayUrl.trim()) {
      for (const epoch of new Set([...this.legacySockets.keys(), ...this.legacyPeers.keys()])) {
        this.closeLegacyEpoch(epoch);
      }
      return;
    }

    const wanted = new Set(
      (this.config.legacyEpochs ?? []).filter(
        (epoch) => epoch !== this.config!.epoch && this.legacyGroupKeys.has(epoch),
      ),
    );
    for (const epoch of new Set([...this.legacySockets.keys(), ...this.legacyPeers.keys()])) {
      if (!wanted.has(epoch)) this.closeLegacyEpoch(epoch);
    }
    for (const epoch of wanted) {
      this.scheduleLegacyExpiry(epoch);
      if (!this.legacySockets.has(epoch)) await this.connectLegacyWebSocket(epoch);
    }
  }

  private async connectLegacyWebSocket(epoch: number): Promise<void> {
    const config = this.config;
    if (this.stopped || !config?.relayUrl.trim()) return;
    const keys = this.legacyGroupKeys.get(epoch);
    if (!keys) return;
    this.scheduleLegacyMidnightRollover(epoch);

    const topicId = await deriveTopicId(keys.topicKey);
    if (
      this.stopped ||
      this.config !== config ||
      !config.relayUrl.trim() ||
      this.legacyGroupKeys.get(epoch) !== keys ||
      Date.now() - (this.legacyRotatedAt.get(epoch) ?? 0) > PREVIOUS_GROUP_SECRET_MAX_AGE_MS
    ) {
      return;
    }
    const ws = new WebSocket(normalizeRelayWsUrl(config.relayUrl, topicId));
    ws.binaryType = 'arraybuffer';
    this.legacySockets.set(epoch, ws);

    ws.onopen = () => {
      if (this.legacySockets.get(epoch) !== ws || this.stopped || !this.config) return;
      this.legacyReconnectAttempts.set(epoch, 0);
      this.scheduleRelayKeepalives();
      void this.sendSignal(
        {
          t: 'hello',
          from: this.config.deviceId,
          fromName: this.config.deviceName,
          epoch,
          certHash: this.ownCertHash,
        },
        epoch,
      );
      for (const slot of this.legacyPeers.get(epoch)?.values() ?? []) {
        if (slot.connectedEmitted) {
          this.emit({ type: 'peer-channel', peerId: slot.peerId, epoch, channel: 'relay' });
        }
      }
    };

    ws.onmessage = (event) => {
      if (this.legacySockets.get(epoch) !== ws || this.stopped) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      void this.handleLegacyRelayFrame(epoch, new Uint8Array(event.data));
    };

    ws.onclose = () => {
      if (this.legacySockets.get(epoch) !== ws) return;
      this.legacySockets.delete(epoch);
      if (this.stopped) return;
      this.scheduleLegacyReconnect(epoch);
    };
  }

  private scheduleLegacyReconnect(epoch: number): void {
    if (this.stopped || this.legacyReconnectTimers.has(epoch)) return;
    const attempts = this.legacyReconnectAttempts.get(epoch) ?? 0;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);
    this.legacyReconnectAttempts.set(epoch, attempts + 1);
    const timer = setTimeout(() => {
      this.legacyReconnectTimers.delete(epoch);
      void this.connectLegacyWebSocket(epoch);
    }, delay);
    this.legacyReconnectTimers.set(epoch, timer);
  }

  private scheduleLegacyMidnightRollover(epoch: number): void {
    const oldTimer = this.legacyMidnightTimers.get(epoch);
    if (oldTimer) clearTimeout(oldTimer);
    const now = Date.now();
    const nextMidnight = Date.parse(`${utcDayString(now)}T00:00:00.000Z`) + 86_400_000;
    const jitter = Math.floor(Math.random() * (MIDNIGHT_JITTER_MAX_MS + 1));
    const timer = setTimeout(() => {
      this.legacyMidnightTimers.delete(epoch);
      if (this.stopped || !this.config?.relayUrl.trim() || !this.legacyGroupKeys.has(epoch)) return;
      const previous = this.legacySockets.get(epoch);
      this.legacySockets.delete(epoch);
      const reconnect = this.legacyReconnectTimers.get(epoch);
      if (reconnect) clearTimeout(reconnect);
      this.legacyReconnectTimers.delete(epoch);
      this.legacyReconnectAttempts.set(epoch, 0);
      if (previous) {
        previous.onopen = null;
        previous.onmessage = null;
        previous.onclose = null;
        try {
          previous.close(1000, 'topic rollover');
        } catch {
          // ignore
        }
      }
      void this.connectLegacyWebSocket(epoch);
    }, Math.max(0, nextMidnight - now + jitter));
    this.legacyMidnightTimers.set(epoch, timer);
  }

  private scheduleLegacyExpiry(epoch: number): void {
    const previousTimer = this.legacyExpiryTimers.get(epoch);
    if (previousTimer) clearTimeout(previousTimer);
    const rotatedAt = this.legacyRotatedAt.get(epoch);
    if (rotatedAt === undefined) return;
    const expiryAt = rotatedAt + PREVIOUS_GROUP_SECRET_MAX_AGE_MS + 1;
    const timer = setTimeout(() => {
      this.legacyExpiryTimers.delete(epoch);
      if (Date.now() < expiryAt) {
        this.scheduleLegacyExpiry(epoch);
      } else {
        this.closeLegacyEpoch(epoch);
      }
    }, Math.min(MAX_TIMEOUT_MS, Math.max(0, expiryAt - Date.now())));
    this.legacyExpiryTimers.set(epoch, timer);
  }

  private closeLegacyEpoch(epoch: number): void {
    const reconnect = this.legacyReconnectTimers.get(epoch);
    if (reconnect) clearTimeout(reconnect);
    this.legacyReconnectTimers.delete(epoch);
    const midnight = this.legacyMidnightTimers.get(epoch);
    if (midnight) clearTimeout(midnight);
    this.legacyMidnightTimers.delete(epoch);
    const expiry = this.legacyExpiryTimers.get(epoch);
    if (expiry) clearTimeout(expiry);
    this.legacyExpiryTimers.delete(epoch);
    const ws = this.legacySockets.get(epoch);
    this.legacySockets.delete(epoch);
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000, 'legacy epoch closed');
      } catch {
        // ignore
      }
    }
    const peers = this.legacyPeers.get(epoch);
    if (peers) {
      for (const slot of peers.values()) this.cleanupPeerSlot(slot, true);
      peers.clear();
      this.legacyPeers.delete(epoch);
    }
    this.legacyRelayChunks.clear();
    this.legacyReconnectAttempts.delete(epoch);
    this.legacyGroupKeys.delete(epoch);
    this.legacyRotatedAt.delete(epoch);
  }

  private scheduleRelayKeepalives(): void {
    if (this.stopped || this.keepaliveTimer) return;
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      if (this.stopped) return;
      for (const slot of this.peers.values()) {
        if (slot.channel === 'relay' && slot.connectedEmitted) void this.sendRelayKeepalive(slot);
      }
      for (const peers of this.legacyPeers.values()) {
        for (const slot of peers.values()) {
          if (slot.connectedEmitted) void this.sendRelayKeepalive(slot);
        }
      }
      this.scheduleRelayKeepalives();
    }, RELAY_KEEPALIVE_MS);
  }

  private async sendRelayKeepalive(slot: PeerSlot): Promise<void> {
    if (!this.config) return;
    await this.sendSignal(
      {
        t: 'hello',
        from: this.config.deviceId,
        fromName: this.config.deviceName,
        to: slot.peerId,
        epoch: slot.epoch,
        certHash: this.ownCertHash,
      },
      slot.epoch,
    );
  }

  private refreshRelayPresence(slot: PeerSlot): void {
    slot.lastSeenAt = Date.now();
    if (slot.channel !== 'relay') return;
    if (slot.presenceTimer) clearTimeout(slot.presenceTimer);
    slot.presenceTimer = setTimeout(() => {
      slot.presenceTimer = null;
      if (slot.channel !== 'relay' || Date.now() - slot.lastSeenAt < RELAY_PEER_EXPIRY_MS) return;
      if (slot.epoch === this.config?.epoch) {
        this.removePeerSlot(slot, true);
      } else {
        this.removeLegacyPeerSlot(slot, true);
      }
    }, RELAY_PEER_EXPIRY_MS);
  }

  private scheduleMidnightRollover(): void {
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    this.midnightTimer = null;
    if (this.stopped || !this.config?.relayUrl.trim()) return;
    const now = Date.now();
    const today = utcDayString(now);
    const nextMidnight = Date.parse(`${today}T00:00:00.000Z`) + 86_400_000;
    const jitter = Math.floor(Math.random() * (MIDNIGHT_JITTER_MAX_MS + 1));
    this.midnightTimer = setTimeout(() => {
      this.midnightTimer = null;
      if (this.stopped || !this.config) return;
      const previous = this.ws;
      this.ws = null;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      if (previous) {
        previous.onopen = null;
        previous.onmessage = null;
        previous.onerror = null;
        previous.onclose = null;
        try {
          previous.close(1000, 'topic rollover');
        } catch {
          // ignore
        }
      }
      void this.connectWebSocket();
    }, Math.max(0, nextMidnight - now + jitter));
  }

  private async sendSignal(msg: SignalEnvelope, epoch = msg.epoch): Promise<void> {
    const isCurrentEpoch = epoch === this.config?.epoch;
    const socket = isCurrentEpoch ? this.ws : this.legacySockets.get(epoch);
    const keys = isCurrentEpoch ? this.groupKeys : this.legacyGroupKeys.get(epoch);
    if (!socket || socket.readyState !== WebSocket.OPEN || !keys) return;
    const wrapped = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      payload: msg,
    };
    const frame = await sealRelayFrame(keys, wrapped);
    const activeSocket = epoch === this.config?.epoch ? this.ws : this.legacySockets.get(epoch);
    if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(frame);
    } catch {
      return;
    }
  }

  private async handleRelayFrame(bytes: Uint8Array): Promise<void> {
    if (!this.groupKeys || !this.config) return;
    let opened: { id: string; ts: number; payload: SignalEnvelope };
    try {
      opened = await openRelayFrame<{ id: string; ts: number; payload: SignalEnvelope }>(this.groupKeys, bytes);
    } catch {
      return;
    }
    if (!opened || !this.replayGuard.accept(opened.id, opened.ts)) return;
    const msg = opened.payload;
    if (!msg || typeof msg !== 'object' || msg.from === this.config.deviceId) return;
    if (msg.to && msg.to !== this.config.deviceId) return;
    const existing = this.peers.get(msg.from);
    if (existing?.channel === 'relay') this.refreshRelayPresence(existing);

    if (msg.t === 'hello') {
      await this.handlePeerHello(msg);
    } else if (msg.t === 'offer') {
      await this.handlePeerOffer(msg);
    } else if (msg.t === 'answer') {
      await this.handlePeerAnswer(msg);
    } else if (msg.t === 'ice') {
      await this.handlePeerIce(msg);
    } else if (msg.t === 'bye') {
      const slot = this.peers.get(msg.from);
      if (slot) {
        this.cleanupPeerSlot(slot, true);
        this.peers.delete(msg.from);
      }
    } else if (msg.t === 'relay-data') {
      this.handleRelayDataChunk(msg);
    }
  }

  private async handleLegacyRelayFrame(epoch: number, bytes: Uint8Array): Promise<void> {
    const keys = this.legacyGroupKeys.get(epoch);
    const config = this.config;
    if (!keys || !config) return;
    let opened: { id: string; ts: number; payload: SignalEnvelope };
    try {
      opened = await openRelayFrame<{ id: string; ts: number; payload: SignalEnvelope }>(keys, bytes);
    } catch {
      return;
    }
    if (!opened || !this.replayGuard.accept(opened.id, opened.ts)) return;
    const msg = opened.payload;
    if (!msg || typeof msg !== 'object' || msg.from === config.deviceId) return;
    if (msg.to && msg.to !== config.deviceId) return;

    const existing = this.legacyPeers.get(epoch)?.get(msg.from);
    if (existing) this.refreshRelayPresence(existing);
    if (msg.t === 'hello') {
      await this.handleLegacyPeerHello(epoch, msg);
    } else if (msg.t === 'relay-data') {
      this.handleLegacyRelayDataChunk(epoch, msg);
    } else if (msg.t === 'bye') {
      const slot = this.legacyPeers.get(epoch)?.get(msg.from);
      if (slot) this.removeLegacyPeerSlot(slot);
    }
  }

  private async handleLegacyPeerHello(epoch: number, msg: SignalEnvelope): Promise<void> {
    if (!this.config || !this.legacyGroupKeys.has(epoch)) return;
    const existing = this.legacyPeers.get(epoch)?.get(msg.from);
    if (
      existing &&
      msg.certHash &&
      existing.peerCertHash &&
      msg.certHash !== existing.peerCertHash
    ) {
      this.removeLegacyPeerSlot(existing);
    }
    const slot = this.getOrCreateLegacySlot(epoch, msg.from, msg.fromName, msg.certHash);
    this.refreshRelayPresence(slot);
    if (!msg.to) {
      await this.sendSignal(
        {
          t: 'hello',
          from: this.config.deviceId,
          fromName: this.config.deviceName,
          to: msg.from,
          epoch,
          certHash: this.ownCertHash,
        },
        epoch,
      );
    }
  }

  private getOrCreateLegacySlot(epoch: number, peerId: string, peerName?: string, peerCertHash?: string): PeerSlot {
    let peers = this.legacyPeers.get(epoch);
    if (!peers) {
      peers = new Map();
      this.legacyPeers.set(epoch, peers);
    }
    let slot = peers.get(peerId);
    if (!slot) {
      slot = {
        peerId,
        epoch,
        peerName: peerName || peerId.slice(0, 8),
        peerCertHash: peerCertHash || '',
        pc: null,
        dc: null,
        offerId: null,
        channel: 'relay',
        connectedEmitted: true,
        fallbackTimer: null,
        disconnectedTimer: null,
        presenceTimer: null,
        lastSeenAt: Date.now(),
        pendingIce: [],
        restartedIce: false,
      };
      peers.set(peerId, slot);
      this.emit({
        type: 'peer-connected',
        peerId,
        epoch,
        peerName: slot.peerName,
        channel: 'relay',
        ownCertHash: this.ownCertHash,
        peerCertHash: slot.peerCertHash || this.ownCertHash,
      });
    } else {
      if (peerName) slot.peerName = peerName;
      if (peerCertHash) slot.peerCertHash = peerCertHash;
    }
    return slot;
  }

  private handleLegacyRelayDataChunk(epoch: number, msg: SignalEnvelope): void {
    if (!msg.msgId || typeof msg.idx !== 'number' || typeof msg.total !== 'number' || typeof msg.chunk !== 'string') {
      return;
    }
    const slot = this.getOrCreateLegacySlot(epoch, msg.from, msg.fromName, msg.certHash);
    this.refreshRelayPresence(slot);
    if (msg.total === 1) {
      this.emit({ type: 'peer-message', peerId: msg.from, epoch, payload: msg.chunk });
      return;
    }
    const key = `${epoch}:${msg.from}:${msg.msgId}`;
    let entry = this.legacyRelayChunks.get(key);
    if (!entry) {
      entry = { total: msg.total, parts: new Array<string>(msg.total), createdAt: Date.now() };
      this.legacyRelayChunks.set(key, entry);
    }
    entry.parts[msg.idx] = msg.chunk;
    if (entry.parts.filter((part) => typeof part === 'string').length === entry.total) {
      this.legacyRelayChunks.delete(key);
      this.emit({ type: 'peer-message', peerId: msg.from, epoch, payload: entry.parts.join('') });
    }
  }

  private getOrCreateSlot(peerId: string, peerName?: string, peerCertHash?: string): PeerSlot {
    let slot = this.peers.get(peerId);
    if (!slot) {
      slot = {
        peerId,
        epoch: this.config?.epoch ?? 0,
        peerName: peerName || peerId.slice(0, 8),
        peerCertHash: peerCertHash || '',
        pc: null,
        dc: null,
        offerId: null,
        channel: 'none',
        connectedEmitted: false,
        fallbackTimer: null,
        disconnectedTimer: null,
        presenceTimer: null,
        lastSeenAt: Date.now(),
        pendingIce: [],
        restartedIce: false,
      };
      this.peers.set(peerId, slot);
    } else {
      if (peerName) slot.peerName = peerName;
      if (peerCertHash) slot.peerCertHash = peerCertHash;
    }
    return slot;
  }

  private cleanupPeerConnection(slot: PeerSlot, clearPendingIce = true): void {
    if (slot.fallbackTimer) {
      clearTimeout(slot.fallbackTimer);
      slot.fallbackTimer = null;
    }
    if (slot.disconnectedTimer) {
      clearTimeout(slot.disconnectedTimer);
      slot.disconnectedTimer = null;
    }

    const dc = slot.dc;
    slot.dc = null;
    if (dc) {
      dc.onopen = null;
      dc.onmessage = null;
      dc.onclose = null;
      try {
        dc.close();
      } catch {
        // ignore
      }
    }

    const pc = slot.pc;
    slot.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    slot.offerId = null;
    if (clearPendingIce) slot.pendingIce = [];
    slot.restartedIce = false;
  }

  private cleanupPeerSlot(slot: PeerSlot, notify: boolean): void {
    this.cleanupPeerConnection(slot);
    if (slot.presenceTimer) {
      clearTimeout(slot.presenceTimer);
      slot.presenceTimer = null;
    }
    slot.channel = 'none';
    if (notify && slot.connectedEmitted) {
      slot.connectedEmitted = false;
      this.emit({ type: 'peer-disconnected', peerId: slot.peerId, epoch: slot.epoch });
    }
  }

  private removePeerSlot(slot: PeerSlot, resendHello: boolean): void {
    if (this.peers.get(slot.peerId) !== slot) return;
    this.cleanupPeerSlot(slot, true);
    this.peers.delete(slot.peerId);
    if (resendHello) void this.sendRelayHello().catch(() => {});
  }

  private removeLegacyPeerSlot(slot: PeerSlot, resendHello = false): void {
    const peers = this.legacyPeers.get(slot.epoch);
    if (peers?.get(slot.peerId) !== slot) return;
    this.cleanupPeerSlot(slot, true);
    peers.delete(slot.peerId);
    if (peers.size === 0) this.legacyPeers.delete(slot.epoch);
    if (resendHello && this.config) {
      void this.sendSignal(
        {
          t: 'hello',
          from: this.config.deviceId,
          fromName: this.config.deviceName,
          epoch: slot.epoch,
          certHash: this.ownCertHash,
        },
        slot.epoch,
      ).catch(() => {});
    }
  }

  private handleDirectConnectionFailure(slot: PeerSlot): void {
    if (slot.channel === 'relay') {
      this.cleanupPeerConnection(slot);
      return;
    }
    if (!this.activateRelayFallback(slot)) this.removePeerSlot(slot, true);
  }

  private async sendRelayHello(): Promise<void> {
    if (!this.config) return;
    await this.sendSignal({
      t: 'hello',
      from: this.config.deviceId,
      fromName: this.config.deviceName,
      epoch: this.config.epoch,
      certHash: this.ownCertHash,
    });
  }

  private createPeerConnection(slot: PeerSlot): RTCPeerConnection {
    const iceServers: RTCIceServer[] =
      this.config?.stunEnabled && this.config.stunUrls.length
        ? this.config.stunUrls.map((urls) => ({ urls }))
        : [];
    const rtcConfig: RTCConfiguration = {
      iceServers,
      ...(this.certificate ? { certificates: [this.certificate] } : {}),
    };
    const pc = new RTCPeerConnection(rtcConfig);
    slot.pc = pc;

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !this.config) return;
      void this.sendSignal({
        t: 'ice',
        from: this.config.deviceId,
        to: slot.peerId,
        epoch: this.config.epoch,
        re: slot.offerId ?? undefined,
        candidate: ev.candidate.toJSON(),
      });
    };

    pc.oniceconnectionstatechange = () => {
      if (slot.pc !== pc) return;
      if (slot.channel === 'relay') {
        this.cleanupPeerConnection(slot);
        return;
      }
      if (pc.iceConnectionState === 'failed') {
        if (!slot.restartedIce && typeof pc.restartIce === 'function') {
          slot.restartedIce = true;
          pc.restartIce();
        } else {
          this.handleDirectConnectionFailure(slot);
        }
      } else if (pc.iceConnectionState === 'closed' && slot.channel === 'webrtc') {
        this.handleDirectConnectionFailure(slot);
      }
    };

    pc.onconnectionstatechange = () => {
      if (slot.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.handleDirectConnectionFailure(slot);
        return;
      }
      if (pc.connectionState === 'disconnected') {
        if (slot.disconnectedTimer) clearTimeout(slot.disconnectedTimer);
        slot.disconnectedTimer = setTimeout(() => {
          slot.disconnectedTimer = null;
          if (slot.pc === pc && pc.connectionState === 'disconnected') {
            this.handleDirectConnectionFailure(slot);
          }
        }, PEER_DISCONNECTED_TIMEOUT_MS);
      } else if (slot.disconnectedTimer) {
        clearTimeout(slot.disconnectedTimer);
        slot.disconnectedTimer = null;
      }
    };

    pc.ondatachannel = (ev) => {
      if (slot.pc !== pc) return;
      this.attachDataChannel(slot, ev.channel);
    };

    if (slot.fallbackTimer) clearTimeout(slot.fallbackTimer);
    slot.fallbackTimer = setTimeout(() => {
      if (slot.channel !== 'webrtc' && !this.stopped) {
        if (!this.activateRelayFallback(slot)) this.removePeerSlot(slot, true);
      }
    }, WEBRTC_FALLBACK_TIMEOUT_MS);

    return pc;
  }

  private attachDataChannel(slot: PeerSlot, dc: RTCDataChannel): void {
    slot.dc = dc;
    dc.onopen = () => {
      if (slot.dc !== dc) return;
      if (slot.fallbackTimer) {
        clearTimeout(slot.fallbackTimer);
        slot.fallbackTimer = null;
      }
      slot.channel = 'webrtc';
      const localFp = extractSdpFingerprint(slot.pc?.localDescription?.sdp) || this.ownCertHash;
      const remoteFp = extractSdpFingerprint(slot.pc?.remoteDescription?.sdp) || slot.peerCertHash;
      slot.connectedEmitted = true;
      this.emit({
        type: 'peer-connected',
        peerId: slot.peerId,
        epoch: slot.epoch,
        peerName: slot.peerName,
        channel: 'webrtc',
        ownCertHash: localFp,
        peerCertHash: remoteFp,
      });
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.emit({ type: 'peer-message', peerId: slot.peerId, epoch: slot.epoch, payload: ev.data });
      }
    };
    dc.onclose = () => {
      if (slot.dc !== dc) return;
      this.handleDirectConnectionFailure(slot);
    };
  }

  private activateRelayFallback(slot: PeerSlot): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (slot.channel === 'relay') {
      this.cleanupPeerConnection(slot);
      return true;
    }
    if (slot.fallbackTimer) {
      clearTimeout(slot.fallbackTimer);
      slot.fallbackTimer = null;
    }
    const wasConnected = slot.connectedEmitted;
    this.cleanupPeerConnection(slot);
    slot.channel = 'relay';
    slot.connectedEmitted = true;
    this.refreshRelayPresence(slot);
    if (wasConnected) {
      this.emit({ type: 'peer-channel', peerId: slot.peerId, epoch: slot.epoch, channel: 'relay' });
    } else {
      this.emit({
        type: 'peer-connected',
        peerId: slot.peerId,
        epoch: slot.epoch,
        peerName: slot.peerName,
        channel: 'relay',
        ownCertHash: this.ownCertHash,
        peerCertHash: slot.peerCertHash || this.ownCertHash,
      });
    }
    return true;
  }

  private async handlePeerHello(msg: SignalEnvelope): Promise<void> {
    if (!this.config) return;
    const existing = this.peers.get(msg.from);
    if (existing?.channel === 'relay') this.refreshRelayPresence(existing);
    if (existing && msg.certHash && existing.peerCertHash && msg.certHash !== existing.peerCertHash) {
      this.removePeerSlot(existing, false);
    }
    const slot = this.getOrCreateSlot(msg.from, msg.fromName, msg.certHash);

    // A returning peer may have lost its slot even though we kept the relay fallback.
    if (!msg.to) {
      await this.sendSignal({
        t: 'hello',
        from: this.config.deviceId,
        fromName: this.config.deviceName,
        to: msg.from,
        epoch: this.config.epoch,
        certHash: this.ownCertHash,
        relayFallback: slot.channel === 'relay' ? true : undefined,
      });
    }

    // If WebRTC is already open to this peer, keep the existing connection intact!
    if (slot.channel === 'relay' || (slot.channel === 'webrtc' && slot.dc?.readyState === 'open')) return;

    if (msg.to && msg.relayFallback && this.activateRelayFallback(slot)) return;

    // Deterministic initiator: lexicographically smaller deviceId sends the offer.
    if (this.config.deviceId < msg.from) {
      if (typeof RTCPeerConnection === 'undefined') {
        this.activateRelayFallback(slot);
        return;
      }
      if (slot.pc && slot.pc.signalingState === 'have-local-offer') return;
      this.cleanupPeerSlot(slot, false);
      const pc = this.createPeerConnection(slot);
      const dc = pc.createDataChannel('kiwi-sync', { ordered: true });
      this.attachDataChannel(slot, dc);
      const offerId = crypto.randomUUID();
      slot.offerId = offerId;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal({
        t: 'offer',
        from: this.config.deviceId,
        fromName: this.config.deviceName,
        to: msg.from,
        epoch: this.config.epoch,
        certHash: extractSdpFingerprint(offer.sdp) || this.ownCertHash,
        offerId,
        sdp: offer.sdp,
      });
    }
  }

  private async handlePeerOffer(msg: SignalEnvelope): Promise<void> {
    if (!this.config || !msg.sdp || !msg.offerId) return;
    const existing = this.peers.get(msg.from);
    const certChanged =
      existing && msg.certHash && existing.peerCertHash && msg.certHash !== existing.peerCertHash;
    const negotiationChanged = existing && existing.offerId !== null && existing.offerId !== msg.offerId;
    if (existing && (certChanged || negotiationChanged)) {
      this.removePeerSlot(existing, false);
    }
    const slot = this.getOrCreateSlot(msg.from, msg.fromName, msg.certHash);
    if (slot.channel === 'relay') return;
    if (slot.offerId === msg.offerId && slot.pc) return;
    if (typeof RTCPeerConnection === 'undefined') {
      this.activateRelayFallback(slot);
      return;
    }
    if (slot.pc) this.cleanupPeerConnection(slot, false);
    const pc = this.createPeerConnection(slot);
    slot.offerId = msg.offerId;
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    for (const queued of slot.pendingIce) {
      if (!queued.offerId || queued.offerId === msg.offerId) {
        await pc.addIceCandidate(queued.candidate).catch(() => {});
      }
    }
    slot.pendingIce = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.sendSignal({
      t: 'answer',
      from: this.config.deviceId,
      fromName: this.config.deviceName,
      to: msg.from,
      epoch: this.config.epoch,
      certHash: extractSdpFingerprint(answer.sdp) || this.ownCertHash,
      re: msg.offerId,
      sdp: answer.sdp,
    });
  }

  private async handlePeerAnswer(msg: SignalEnvelope): Promise<void> {
    if (!msg.sdp) return;
    const slot = this.peers.get(msg.from);
    if (!slot || !slot.pc) return;
    if (msg.re && slot.offerId && msg.re !== slot.offerId) return;
    if (slot.pc.signalingState !== 'have-local-offer') return;
    if (msg.certHash) slot.peerCertHash = msg.certHash;
    await slot.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    for (const queued of slot.pendingIce) {
      if (!queued.offerId || queued.offerId === slot.offerId) {
        await slot.pc.addIceCandidate(queued.candidate).catch(() => {});
      }
    }
    slot.pendingIce = [];
  }

  private async handlePeerIce(msg: SignalEnvelope): Promise<void> {
    if (!msg.candidate) return;
    const slot = this.peers.get(msg.from);
    if (!slot) return;
    if (slot.channel === 'relay') return;
    if (msg.re && slot.offerId && msg.re !== slot.offerId) return;
    if (slot.pc && slot.pc.remoteDescription) {
      await slot.pc.addIceCandidate(msg.candidate).catch(() => {});
    } else {
      slot.pendingIce.push({ offerId: msg.re ?? null, candidate: msg.candidate });
    }
  }

  private handleRelayDataChunk(msg: SignalEnvelope): void {
    if (!msg.msgId || typeof msg.idx !== 'number' || typeof msg.total !== 'number' || typeof msg.chunk !== 'string') {
      return;
    }
    const slot = this.getOrCreateSlot(msg.from, msg.fromName, msg.certHash);
    if (!slot.connectedEmitted) {
      this.activateRelayFallback(slot);
    }
    this.refreshRelayPresence(slot);
    if (msg.total === 1) {
      this.emit({ type: 'peer-message', peerId: msg.from, epoch: slot.epoch, payload: msg.chunk });
      return;
    }
    const key = `${slot.epoch}:${msg.from}:${msg.msgId}`;
    let entry = this.relayChunks.get(key);
    if (!entry) {
      entry = { total: msg.total, parts: new Array<string>(msg.total), createdAt: Date.now() };
      this.relayChunks.set(key, entry);
    }
    entry.parts[msg.idx] = msg.chunk;
    if (entry.parts.filter((p) => typeof p === 'string').length === entry.total) {
      this.relayChunks.delete(key);
      this.emit({ type: 'peer-message', peerId: msg.from, epoch: slot.epoch, payload: entry.parts.join('') });
    }
  }

  async sendToPeer(peerId: string, payload: string, epoch = this.config?.epoch): Promise<boolean> {
    if (epoch === undefined) return false;
    const hasLegacyEpoch = epoch !== this.config?.epoch && this.legacyGroupKeys.has(epoch);
    const isCurrentEpoch = epoch === this.config?.epoch || (!hasLegacyEpoch && this.peers.has(peerId));
    const slot = isCurrentEpoch ? this.peers.get(peerId) : this.legacyPeers.get(epoch)?.get(peerId);
    if (!slot) return false;
    const signalEpoch = isCurrentEpoch ? (this.config?.epoch ?? epoch) : epoch;
    if (isCurrentEpoch && slot.channel === 'webrtc' && slot.dc && slot.dc.readyState === 'open') {
      slot.dc.send(payload);
      return true;
    }
    const socket = isCurrentEpoch ? this.ws : this.legacySockets.get(epoch);
    if (socket && socket.readyState === WebSocket.OPEN && this.config) {
      const msgId = crypto.randomUUID().slice(0, 12);
      const total = Math.max(1, Math.ceil(payload.length / RELAY_CHUNK_CHARS));
      for (let idx = 0; idx < total; idx += 1) {
        const chunk = payload.slice(idx * RELAY_CHUNK_CHARS, (idx + 1) * RELAY_CHUNK_CHARS);
        await this.sendSignal({
          t: 'relay-data',
          from: this.config.deviceId,
          fromName: this.config.deviceName,
          to: peerId,
          epoch: signalEpoch,
          certHash: this.ownCertHash,
          msgId,
          idx,
          total,
          chunk,
        }, signalEpoch);
      }
      return true;
    }
    return false;
  }

  async broadcast(payload: string): Promise<void> {
    for (const peerId of this.peers.keys()) {
      await this.sendToPeer(peerId, payload).catch(() => {});
    }
    for (const [epoch, peers] of this.legacyPeers) {
      for (const peerId of peers.keys()) {
        await this.sendToPeer(peerId, payload, epoch).catch(() => {});
      }
    }
  }

  /** Relay-free fallback: generate an encrypted kiwi1- offer connection code. */
  async createOfferCode(): Promise<string> {
    const groupKeys = await this.ensureKeysAndCertificate();
    if (!this.config) throw new Error('Sync transport not configured');
    if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC unavailable');

    if (this.manualOfferSlot) {
      try {
        this.manualOfferSlot.pc.close();
      } catch {
        // ignore
      }
      this.manualOfferSlot = null;
    }

    const iceServers: RTCIceServer[] =
      this.config.stunEnabled && this.config.stunUrls.length
        ? this.config.stunUrls.map((urls) => ({ urls }))
        : [];
    const pc = new RTCPeerConnection({
      iceServers,
      ...(this.certificate ? { certificates: [this.certificate] } : {}),
    });
    const dc = pc.createDataChannel('kiwi-sync', { ordered: true });
    const candidates: CompactIceCandidate[] = [];

    const gathered = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2500);
      pc.onicecandidate = (ev) => {
        if (ev.candidate?.candidate) {
          const parsed = parseCandidateString(ev.candidate.candidate);
          if (parsed) candidates.push(parsed);
        } else {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gathered;

    const creds = extractSdpIceCredentials(pc.localDescription?.sdp ?? offer.sdp ?? '');
    this.manualOfferSlot = { pc, dc, peerId: '' };

    return encodeConnectionCode(groupKeys, {
      kind: 'offer',
      epoch: this.config.epoch,
      deviceId: this.config.deviceId,
      timestampMs: Date.now(),
      ufrag: creds.ufrag,
      pwd: creds.pwd,
      fingerprint: creds.fingerprint,
      candidates,
    });
  }

  /** Relay-free fallback: accept a kiwi1- offer code and generate an encrypted kiwi1- answer code. */
  async createAnswerCode(offerCode: string): Promise<string> {
    const groupKeys = await this.ensureKeysAndCertificate();
    if (!this.config) throw new Error('Sync transport not configured');
    if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC unavailable');

    const decoded = await decodeConnectionCode(groupKeys, offerCode);
    if (decoded.kind !== 'offer') throw new Error('Expected an offer connection code');

    const slot = this.getOrCreateSlot(decoded.deviceId, decoded.deviceId.slice(0, 8), decoded.fingerprint);
    this.cleanupPeerSlot(slot, false);
    const pc = this.createPeerConnection(slot);
    if (slot.fallbackTimer) {
      clearTimeout(slot.fallbackTimer);
      slot.fallbackTimer = null;
    }

    const candidates: CompactIceCandidate[] = [];
    const gathered = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2500);
      pc.onicecandidate = (ev) => {
        if (ev.candidate?.candidate) {
          const parsed = parseCandidateString(ev.candidate.candidate);
          if (parsed) candidates.push(parsed);
        } else {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    const remoteSdp = buildCompactSdp({
      ufrag: decoded.ufrag,
      pwd: decoded.pwd,
      fingerprint: decoded.fingerprint,
      candidates: decoded.candidates,
      setup: 'actpass',
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await gathered;

    const creds = extractSdpIceCredentials(pc.localDescription?.sdp ?? answer.sdp ?? '');
    return encodeConnectionCode(groupKeys, {
      kind: 'answer',
      epoch: this.config.epoch,
      deviceId: this.config.deviceId,
      timestampMs: Date.now(),
      ufrag: creds.ufrag,
      pwd: creds.pwd,
      fingerprint: creds.fingerprint,
      candidates,
    });
  }

  /** Relay-free fallback: complete pairing on the offer side by applying the peer's kiwi1- answer code. */
  async acceptAnswerCode(answerCode: string): Promise<void> {
    const groupKeys = await this.ensureKeysAndCertificate();
    if (!this.manualOfferSlot) throw new Error('No pending offer connection; generate an offer code first');

    const decoded = await decodeConnectionCode(groupKeys, answerCode);
    if (decoded.kind !== 'answer') throw new Error('Expected an answer connection code');

    const { pc, dc } = this.manualOfferSlot;
    this.manualOfferSlot = null;

    const slot = this.getOrCreateSlot(decoded.deviceId, decoded.deviceId.slice(0, 8), decoded.fingerprint);
    this.cleanupPeerSlot(slot, false);
    slot.pc = pc;
    this.attachDataChannel(slot, dc);

    const remoteSdp = buildCompactSdp({
      ufrag: decoded.ufrag,
      pwd: decoded.pwd,
      fingerprint: decoded.fingerprint,
      candidates: decoded.candidates,
      setup: 'active',
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp });
  }
}
