import {
  ReplayGuard,
  decodeConnectionCode,
  deriveTopicId,
  encodeConnectionCode,
  openRelayFrame,
  sealRelayFrame,
  type CompactIceCandidate,
  type GroupKeys,
  utcDayString,
} from '@kiwi-search/sync';
import type { SyncPeerChannel, SyncTransportState } from '@kiwi-search/protocol';
import { createDefaultSyncStorage } from './syncDb';

export interface TransportConfig {
  deviceId: string;
  deviceName: string;
  epoch: number;
  relayUrl: string;
  stunEnabled: boolean;
  stunUrls: string[];
}

export type TransportEvent =
  | { type: 'state'; state: SyncTransportState; error?: string }
  | {
      type: 'snapshot';
      state: SyncTransportState;
      error?: string;
      peers: Array<{
        peerId: string;
        peerName: string;
        channel: SyncPeerChannel;
        ownCertHash: string;
        peerCertHash: string;
      }>;
    }
  | {
      type: 'peer-connected';
      peerId: string;
      peerName: string;
      channel: SyncPeerChannel;
      ownCertHash: string;
      peerCertHash: string;
    }
  | { type: 'peer-disconnected'; peerId: string }
  | { type: 'peer-message'; peerId: string; payload: string };

interface SignalEnvelope {
  t: 'hello' | 'offer' | 'answer' | 'ice' | 'bye' | 'relay-data';
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
  peerName: string;
  peerCertHash: string;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  offerId: string | null;
  channel: SyncPeerChannel;
  connectedEmitted: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  pendingIce: RTCIceCandidateInit[];
  restartedIce: boolean;
}

const WEBRTC_FALLBACK_TIMEOUT_MS = 6_000;
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
  private replayGuard = new ReplayGuard();
  private peers = new Map<string, PeerSlot>();
  private relayChunks = new Map<string, { total: number; parts: string[]; createdAt: number }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
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

  private async ensureKeysAndCertificate(): Promise<GroupKeys> {
    const storage = createDefaultSyncStorage();
    const record = await storage.load();
    if (!record) throw new Error('Sync group is not configured');
    this.groupKeys = record.groupKeys;

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
    if (!this.ownCertHash) this.ownCertHash = this.config?.deviceId ?? 'kiwi-sync';
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
        await this.ensureKeysAndCertificate();
      } catch (error) {
        this.groupKeys = previousKeys;
        this.emit({ type: 'state', state: 'error', error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const nextTopicId = await deriveTopicId(this.groupKeys!.topicKey);
      if (previousTopicId === nextTopicId) {
        this.config = config;
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
      await this.ensureKeysAndCertificate();
    } catch (error) {
      this.emit({ type: 'state', state: 'error', error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (!config.relayUrl.trim()) {
      this.emit({ type: 'state', state: 'idle' });
      return;
    }

    await this.connectWebSocket();
  }

  getReconnectSnapshot(): Extract<TransportEvent, { type: 'snapshot' }> {
    return {
      type: 'snapshot',
      state: this.transportState,
      error: this.transportError,
      peers: [...this.peers.values()]
        .filter((slot) => slot.connectedEmitted)
        .map((slot) => ({
          peerId: slot.peerId,
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
      this.cleanupPeerSlot(slot, false);
    }
    this.peers.clear();
    this.relayChunks.clear();
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

  private async sendSignal(msg: SignalEnvelope): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.groupKeys) return;
    const wrapped = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      payload: msg,
    };
    const frame = await sealRelayFrame(this.groupKeys, wrapped);
    this.ws.send(frame);
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

  private getOrCreateSlot(peerId: string, peerName?: string, peerCertHash?: string): PeerSlot {
    let slot = this.peers.get(peerId);
    if (!slot) {
      slot = {
        peerId,
        peerName: peerName || peerId.slice(0, 8),
        peerCertHash: peerCertHash || '',
        pc: null,
        dc: null,
        offerId: null,
        channel: 'none',
        connectedEmitted: false,
        fallbackTimer: null,
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

  private cleanupPeerSlot(slot: PeerSlot, notify: boolean): void {
    if (slot.fallbackTimer) {
      clearTimeout(slot.fallbackTimer);
      slot.fallbackTimer = null;
    }
    try {
      slot.dc?.close();
    } catch {
      // ignore
    }
    try {
      slot.pc?.close();
    } catch {
      // ignore
    }
    slot.dc = null;
    slot.pc = null;
    slot.channel = 'none';
    if (notify && slot.connectedEmitted) {
      slot.connectedEmitted = false;
      this.emit({ type: 'peer-disconnected', peerId: slot.peerId });
    }
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
      if (pc.iceConnectionState === 'failed') {
        if (!slot.restartedIce && typeof pc.restartIce === 'function') {
          slot.restartedIce = true;
          pc.restartIce();
        } else {
          this.activateRelayFallback(slot);
        }
      } else if (pc.iceConnectionState === 'closed' && slot.channel === 'webrtc') {
        this.activateRelayFallback(slot);
      }
    };

    pc.ondatachannel = (ev) => {
      if (slot.pc !== pc) return;
      this.attachDataChannel(slot, ev.channel);
    };

    if (slot.fallbackTimer) clearTimeout(slot.fallbackTimer);
    slot.fallbackTimer = setTimeout(() => {
      if (slot.channel !== 'webrtc' && !this.stopped) {
        this.activateRelayFallback(slot);
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
        peerName: slot.peerName,
        channel: 'webrtc',
        ownCertHash: localFp,
        peerCertHash: remoteFp,
      });
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.emit({ type: 'peer-message', peerId: slot.peerId, payload: ev.data });
      }
    };
    dc.onclose = () => {
      if (slot.dc !== dc) return;
      slot.dc = null;
      if (slot.channel === 'webrtc') {
        slot.channel = 'none';
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.activateRelayFallback(slot);
        } else if (slot.connectedEmitted) {
          slot.connectedEmitted = false;
          this.emit({ type: 'peer-disconnected', peerId: slot.peerId });
        }
      }
    };
  }

  private activateRelayFallback(slot: PeerSlot): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (slot.channel === 'webrtc') return;
    if (slot.fallbackTimer) {
      clearTimeout(slot.fallbackTimer);
      slot.fallbackTimer = null;
    }
    slot.channel = 'relay';
    slot.connectedEmitted = true;
    this.emit({
      type: 'peer-connected',
      peerId: slot.peerId,
      peerName: slot.peerName,
      channel: 'relay',
      ownCertHash: this.ownCertHash,
      peerCertHash: slot.peerCertHash || this.ownCertHash,
    });
  }

  private async handlePeerHello(msg: SignalEnvelope): Promise<void> {
    if (!this.config) return;
    const slot = this.getOrCreateSlot(msg.from, msg.fromName, msg.certHash);

    // Reply with directed hello if we haven't connected yet so the newcomer learns our presence.
    if (!msg.to) {
      await this.sendSignal({
        t: 'hello',
        from: this.config.deviceId,
        fromName: this.config.deviceName,
        to: msg.from,
        epoch: this.config.epoch,
        certHash: this.ownCertHash,
      });
    }

    // If WebRTC is already open to this peer, keep the existing connection intact!
    if (slot.channel === 'webrtc' && slot.dc?.readyState === 'open') return;

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
    const slot = this.getOrCreateSlot(msg.from, msg.fromName, msg.certHash);
    if (typeof RTCPeerConnection === 'undefined') {
      this.activateRelayFallback(slot);
      return;
    }
    this.cleanupPeerSlot(slot, false);
    const pc = this.createPeerConnection(slot);
    slot.offerId = msg.offerId;
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    for (const c of slot.pendingIce) {
      await pc.addIceCandidate(c).catch(() => {});
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
    for (const c of slot.pendingIce) {
      await slot.pc.addIceCandidate(c).catch(() => {});
    }
    slot.pendingIce = [];
  }

  private async handlePeerIce(msg: SignalEnvelope): Promise<void> {
    if (!msg.candidate) return;
    const slot = this.peers.get(msg.from);
    if (!slot) return;
    if (msg.re && slot.offerId && msg.re !== slot.offerId) return;
    if (slot.pc && slot.pc.remoteDescription) {
      await slot.pc.addIceCandidate(msg.candidate).catch(() => {});
    } else {
      slot.pendingIce.push(msg.candidate);
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
    if (msg.total === 1) {
      this.emit({ type: 'peer-message', peerId: msg.from, payload: msg.chunk });
      return;
    }
    const key = `${msg.from}:${msg.msgId}`;
    let entry = this.relayChunks.get(key);
    if (!entry) {
      entry = { total: msg.total, parts: new Array<string>(msg.total), createdAt: Date.now() };
      this.relayChunks.set(key, entry);
    }
    entry.parts[msg.idx] = msg.chunk;
    if (entry.parts.filter((p) => typeof p === 'string').length === entry.total) {
      this.relayChunks.delete(key);
      this.emit({ type: 'peer-message', peerId: msg.from, payload: entry.parts.join('') });
    }
  }

  async sendToPeer(peerId: string, payload: string): Promise<boolean> {
    const slot = this.peers.get(peerId);
    if (!slot) return false;
    if (slot.channel === 'webrtc' && slot.dc && slot.dc.readyState === 'open') {
      slot.dc.send(payload);
      return true;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.config) {
      const msgId = crypto.randomUUID().slice(0, 12);
      const total = Math.max(1, Math.ceil(payload.length / RELAY_CHUNK_CHARS));
      for (let idx = 0; idx < total; idx += 1) {
        const chunk = payload.slice(idx * RELAY_CHUNK_CHARS, (idx + 1) * RELAY_CHUNK_CHARS);
        await this.sendSignal({
          t: 'relay-data',
          from: this.config.deviceId,
          fromName: this.config.deviceName,
          to: peerId,
          epoch: this.config.epoch,
          certHash: this.ownCertHash,
          msgId,
          idx,
          total,
          chunk,
        });
      }
      return true;
    }
    return false;
  }

  async broadcast(payload: string): Promise<void> {
    for (const peerId of this.peers.keys()) {
      await this.sendToPeer(peerId, payload).catch(() => {});
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
