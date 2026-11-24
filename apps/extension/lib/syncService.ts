import { CONFIG_VERSION } from '@kiwi-search/core';
import {
  canonicalJson,
  classifySyncPath,
  DEFAULT_SYNC_CATEGORIES,
  SyncEngine,
  buildHandshakeHello,
  createHandshakeProof,
  decodeConnectionCode,
  deriveGroupKeys,
  generateDeviceKeys,
  generateRecoveryPhrase,
  importGroupSecret,
  memberCertificate,
  openRecordBody,
  SEARXNG_KEY_PATH,
  phraseToEntropy,
  toBase64Url,
  verifyHandshakeProof,
  verifyMemberCertificate,
  type DeviceKeys,
  type GroupKeys,
  type HandshakeHello,
  type HandshakeProof,
  type LocalChangeInput,
  type SyncCategorySettings,
  type SyncRecordBody,
  type SyncRecordEnvelope,
  type VersionVector,
} from '@kiwi-search/sync';
import { DEFAULT_SYNC_RELAY_URL } from '@kiwi-search/protocol';
import type {
  SyncJoinConflictMode,
  SyncPeerChannel,
  SyncPeerStatus,
  SyncRuntimeMessage,
  SyncRuntimeResponse,
  SyncStatusSnapshot,
  SyncTransportState,
} from '@kiwi-search/protocol';
import { browser } from 'wxt/browser';
import {
  createDefaultSyncStorage,
  prunePreviousGroupSecrets,
  type PreviousGroupSecret,
  type StoredSyncRecord,
  type SyncLocalSettings,
  type SyncStorageAdapter,
} from './syncDb';
import {
  appliedChangesToLocalUpdates,
  extractNonDefaultLocalChanges,
  readLocalSyncChanges,
  uiPreferenceWritesToSyncChanges,
} from './syncMapping';
import { ExtensionSyncTransport, type SyncTransport } from './syncTransportBridge';
import type { TransportEvent } from './syncTransportCore';
import type { SettingsPatch } from './configUpdates';
import { loadConfig } from './settings';

export const DEFAULT_STUN_URLS = ['stun:stun.cloudflare.com:3478'];

interface PeerWireHello {
  type: 'hello';
  hello: HandshakeHello;
}

interface PeerWireProof {
  type: 'proof';
  proof: HandshakeProof;
}

interface PeerWireVv {
  type: 'vv';
  vector: VersionVector;
}

interface PeerWireRecords {
  type: 'records';
  envelopes: SyncRecordEnvelope[];
  vector: VersionVector;
  coveredVector?: VersionVector;
}

interface PeerWireAck {
  type: 'ack';
  vector: VersionVector;
}

type PeerWireMessage = PeerWireHello | PeerWireProof | PeerWireVv | PeerWireRecords | PeerWireAck;

interface LivePeerSession {
  peerId: string;
  epoch: number;
  groupKeys: GroupKeys;
  legacy: boolean;
  peerName: string;
  channel: SyncPeerChannel;
  ownCertHash: string;
  peerCertHash: string;
  ownHello?: HandshakeHello;
  remoteHello?: HandshakeHello;
  authenticated: boolean;
  proofSent: boolean;
  rehandshakePending: boolean;
  remoteVector?: VersionVector;
  lastSeenAt: number;
}

function peerSessionKey(peerId: string, epoch: number): string {
  return `${epoch}:${peerId}`;
}

export interface SyncServiceDeps {
  storage?: SyncStorageAdapter;
  transportFactory?: (onEvent: (event: TransportEvent) => void) => SyncTransport;
  applyRemoteConfigPatches: (patches: SettingsPatch[], pairedSearxngUrl?: string) => Promise<void>;
}

function defaultDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browserName = /Firefox/i.test(ua) ? 'Firefox' : /Edg\//i.test(ua) ? 'Edge' : 'Chrome';
  const os = /Mac/i.test(ua) ? 'macOS' : /Win/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Device';
  return `${browserName} (${os})`;
}

export class SyncService {
  private readonly storage: SyncStorageAdapter;
  private readonly transport: SyncTransport;
  private readonly applyRemoteConfigPatches: SyncServiceDeps['applyRemoteConfigPatches'];

  private engine: SyncEngine | null = null;
  private device: DeviceKeys | null = null;
  private groupSecret: CryptoKey | null = null;
  private groupKeys: GroupKeys | null = null;
  private epochGroupKeys = new Map<number, GroupKeys>();
  private previousGroupSecrets: PreviousGroupSecret[] = [];
  private epochKeys: Record<number, CryptoKey> = {};
  private connectionDefaults = { relayUrl: DEFAULT_SYNC_RELAY_URL, stunEnabled: true, stunUrls: [...DEFAULT_STUN_URLS] };
  private settings: SyncLocalSettings | null = null;

  private transportState: SyncTransportState = 'idle';
  private transportError: string | undefined;
  private lastSyncAt: number | undefined;
  private livePeers = new Map<string, LivePeerSession>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private pendingInitialJoinSync = false;

  constructor(deps: SyncServiceDeps) {
    this.storage = deps.storage ?? createDefaultSyncStorage();
    this.applyRemoteConfigPatches = deps.applyRemoteConfigPatches;
    const factory = deps.transportFactory ?? ((cb) => new ExtensionSyncTransport(cb));
    this.transport = factory((event) => {
      void this.handleTransportEvent(event);
    });
  }

  attachOffscreenPort(port: Browser.runtime.Port): void {
    this.transport.attachOffscreenPort(port);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const stored = await this.storage.load();
        if (!stored) {
          const { syncConnection } = await browser.storage.local.get('syncConnection');
          if (syncConnection) Object.assign(this.connectionDefaults, syncConnection);
        }
        if (stored) {
          stored.device.agreementSig = await memberCertificate(stored.device);
          this.device = stored.device;
          this.groupSecret = stored.groupSecret;
          this.groupKeys = stored.groupKeys;
          this.previousGroupSecrets = prunePreviousGroupSecrets(stored.previousGroupSecrets);
          this.epochGroupKeys.clear();
          this.epochGroupKeys.set(stored.groupKeys.epoch, stored.groupKeys);
          const previousKeys = await Promise.all(
            this.previousGroupSecrets.map((entry) => deriveGroupKeys(entry.secret, entry.epoch)),
          );
          for (const keys of previousKeys) this.epochGroupKeys.set(keys.epoch, keys);
          this.epochKeys = { ...stored.epochKeys };
          this.settings = {
            ...stored.settings,
            stunEnabled: stored.settings.stunEnabled ?? true,
            epochEstablished: stored.settings.epochEstablished ?? true,
          };
          this.pendingInitialJoinSync = stored.settings.pendingInitialJoinSync ?? false;
          this.engine = new SyncEngine({
            device: stored.device,
            deviceName: stored.settings.deviceName,
            groupKeys: stored.groupKeys,
            configVersion: CONFIG_VERSION,
            categories: stored.settings.categories,
            persisted: stored.engineState,
          });
          for (const keys of previousKeys) await this.engine.registerEpochKeys(keys);
          const reclassified = await this.reconcileIncludedRegisters(stored.settings.categories);
          const backfilled = await this.backfillLlmSelections();
          if (reclassified || backfilled.length) await this.persist();
          await this.startTransport();
        }
      } catch (error) {
        this.transportState = 'error';
        this.transportError = error instanceof Error ? error.message : String(error);
      } finally {
        this.initialized = true;
      }
    })();
    return this.initPromise;
  }

  private async persist(): Promise<void> {
    if (!this.engine || !this.device || !this.groupSecret || !this.groupKeys || !this.settings) return;
    const record: StoredSyncRecord = {
      device: this.device,
      groupSecret: this.groupSecret,
      groupKeys: this.groupKeys,
      epochKeys: { ...this.epochKeys, [this.groupKeys.epoch]: this.groupKeys.recordKey },
      previousGroupSecrets: this.previousGroupSecrets,
      settings: this.settings,
      engineState: this.engine.exportState(),
    };
    await this.storage.save(record);
  }

  private retainPreviousGroupSecret(epoch: number, secret: CryptoKey): void {
    if (this.groupKeys?.epoch === epoch) this.epochGroupKeys.set(epoch, this.groupKeys);
    this.previousGroupSecrets = prunePreviousGroupSecrets([
      ...this.previousGroupSecrets.filter((entry) => entry.epoch !== epoch),
      { epoch, secret, rotatedAt: Date.now() },
    ]);
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(work, work);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async startTransport(): Promise<void> {
    if (!this.device || !this.groupKeys || !this.settings) return;
    const retainedSecrets = prunePreviousGroupSecrets(this.previousGroupSecrets);
    const secretsWerePruned = retainedSecrets.length !== this.previousGroupSecrets.length;
    this.previousGroupSecrets = retainedSecrets;
    const retainedEpochs = new Set([this.groupKeys.epoch, ...retainedSecrets.map((entry) => entry.epoch)]);
    for (const epoch of this.epochGroupKeys.keys()) {
      if (!retainedEpochs.has(epoch)) this.epochGroupKeys.delete(epoch);
    }
    this.epochGroupKeys.set(this.groupKeys.epoch, this.groupKeys);
    for (const peer of this.livePeers.values()) {
      peer.legacy =
        peer.epoch !== this.groupKeys.epoch && retainedSecrets.some((entry) => entry.epoch === peer.epoch);
    }
    if (secretsWerePruned) await this.persist();
    await this.transport.start({
      deviceId: this.device.deviceId,
      deviceName: this.settings.deviceName,
      epoch: this.groupKeys.epoch,
      relayUrl: this.settings.relayUrl,
      stunEnabled: this.settings.stunEnabled,
      stunUrls: this.settings.stunUrls,
      legacyEpochs: this.previousGroupSecrets.map((entry) => entry.epoch),
    });
  }

  private async promoteGroupEpoch(epoch: number, remoteEpochEstablished = true): Promise<void> {
    if (!this.engine || !this.groupSecret || !this.groupKeys || !this.settings || !remoteEpochEstablished) return;
    if (this.settings.epochEstablished !== false) return;
    const previousEpoch = this.groupKeys.epoch;
    if (epoch > previousEpoch) {
      const keys = await deriveGroupKeys(this.groupSecret, epoch);
      this.groupKeys = keys;
      this.epochGroupKeys.set(epoch, keys);
      this.epochKeys[epoch] = keys.recordKey;
      await this.engine.registerEpochKeys(keys);
    }
    this.settings.epochEstablished = true;
    await this.persist();
    if (epoch > previousEpoch) await this.startTransport();
  }

  getStatus(): SyncStatusSnapshot {
    if (!this.engine || !this.device || !this.groupKeys || !this.settings) {
      return {
        enabled: false,
        deviceId: null,
        deviceName: defaultDeviceName(),
        epoch: 0,
        ...this.connectionDefaults,
        categories: { ...DEFAULT_SYNC_CATEGORIES },
        transportState: 'idle',
        peers: [],
        recordCount: 0,
        joinConflictMode: 'group',
      };
    }

    const state = this.engine.exportState();
    const peerList: SyncPeerStatus[] = [];
    for (const member of Object.values(state.members)) {
      if (member.deviceId === this.device.deviceId) continue;
      const live =
        this.livePeers.get(peerSessionKey(member.deviceId, this.groupKeys.epoch)) ??
        [...this.livePeers.values()]
          .filter((peer) => peer.peerId === member.deviceId)
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
      peerList.push({
        deviceId: member.deviceId,
        deviceName: live?.peerName || member.deviceName || member.deviceId.slice(0, 8),
        status: member.removedAt ? 'removed' : live ? 'online' : 'offline',
        channel: live?.channel ?? 'none',
        lastSeenAt: live?.lastSeenAt ?? member.lastSeenAt ?? member.joinedAt,
        certFingerprint: live?.peerCertHash || undefined,
      });
    }
    const listedPeerIds = new Set(peerList.map((peer) => peer.deviceId));
    for (const live of this.livePeers.values()) {
      if (state.members[live.peerId] || listedPeerIds.has(live.peerId)) continue;
      listedPeerIds.add(live.peerId);
      peerList.push({
        deviceId: live.peerId,
        deviceName: live.peerName,
        status: 'online',
        channel: live.channel,
        lastSeenAt: live.lastSeenAt,
        certFingerprint: live.peerCertHash || undefined,
      });
    }

    return {
      enabled: true,
      deviceId: this.device.deviceId,
      deviceName: this.settings.deviceName,
      epoch: this.groupKeys.epoch,
      relayUrl: this.settings.relayUrl,
      stunEnabled: this.settings.stunEnabled,
      stunUrls: [...this.settings.stunUrls],
      categories: { ...this.settings.categories },
      transportState: this.transportState,
      transportError: this.transportError,
      peers: peerList,
      lastSyncAt: this.lastSyncAt,
      recordCount: state.recordLog.length,
      joinConflictMode: this.settings.joinConflictMode,
    };
  }

  /** Record local config/domain changes emitted by the serialized settings writer. */
  async recordLocalChanges(changes: readonly LocalChangeInput[]): Promise<void> {
    return this.enqueueMutation(() => this.recordLocalChangesNow(changes));
  }

  private async recordLocalChangesNow(changes: readonly LocalChangeInput[]): Promise<void> {
    await this.init();
    if (!this.engine || !changes.length) return;
    const emitted = await this.engine.applyLocalChanges(changes);
    await this.persist();
    await this.broadcastEnvelopes(emitted);
  }

  async saveUiPreferences(values: Record<string, unknown>): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.init();
      const current = await browser.storage.local.get(Object.keys(values));
      const changes = uiPreferenceWritesToSyncChanges(values, current);
      if (!changes.length) return;
      await browser.storage.local.set(Object.fromEntries(changes.map(({ path, value }) => [path, value])));
      await this.recordLocalChangesNow(changes);
    });
  }

  private async broadcastEnvelopes(envelopes: readonly SyncRecordEnvelope[]): Promise<void> {
    if (!this.engine || !envelopes.length) return;
    for (const peer of this.livePeers.values()) {
      if (!peer.authenticated) continue;
      const peerEnvelopes = peer.legacy
        ? this.legacyControlCatchup(
            peer,
            peer.remoteVector ?? {},
            envelopes.filter(
              (record) =>
                record.epoch === peer.epoch && (record.kind === 'epoch-rotate' || record.kind === 'member-remove'),
            ),
          )
        : [...envelopes];
      if (!peerEnvelopes.length) continue;
      const message: PeerWireRecords = {
        type: 'records',
        envelopes: peerEnvelopes,
        vector: this.engine.getVersionVector(),
      };
      await this.sendPeerPayload(peer, JSON.stringify(message)).catch(() => {});
    }
  }

  private legacyControlCatchup(
    peer: LivePeerSession,
    remoteVector: VersionVector,
    controls?: readonly SyncRecordEnvelope[],
  ): SyncRecordEnvelope[] {
    if (!this.engine || !peer.legacy) return [];
    const allRecords = this.engine.getAllEnvelopes();
    const controlRecords =
      controls ??
      allRecords.filter(
        (record) =>
          record.epoch === peer.epoch && (record.kind === 'epoch-rotate' || record.kind === 'member-remove'),
      );
    if (!controlRecords.length) return [];
    const missing = this.engine.missingRecordsFor(remoteVector);
    return missing.filter(
      (record) =>
        record.epoch === peer.epoch &&
        record.kind !== 'snapshot' &&
        controlRecords.some((control) => control.deviceId === record.deviceId && record.seq <= control.seq),
    );
  }

  private async pruneAcknowledgedPreviousSecrets(): Promise<void> {
    if (!this.engine || !this.device || !this.groupKeys) return;
    const state = this.engine.exportState();
    const activeMembers = this.engine
      .getActiveMembers()
      .filter((member) => member.deviceId === this.device!.deviceId || member.agreementAttested);
    const retained = this.previousGroupSecrets.filter((entry) => {
      const controls = state.recordLog.filter(
        (record) =>
          record.epoch === entry.epoch &&
          (record.kind === 'epoch-rotate' || record.kind === 'member-remove'),
      );
      if (!controls.length) return true;
      return !activeMembers.every(
        (member) =>
          member.deviceId === this.device!.deviceId ||
          controls.every(
            (record) => (state.peerAcks[member.deviceId]?.[record.deviceId] ?? 0) >= record.seq,
          ),
      );
    });
    if (retained.length === this.previousGroupSecrets.length) return;
    const retainedEpochs = new Set(retained.map((entry) => entry.epoch));
    for (const entry of this.previousGroupSecrets) {
      if (!retainedEpochs.has(entry.epoch)) this.epochGroupKeys.delete(entry.epoch);
    }
    this.previousGroupSecrets = retained;
    await this.persist();
    await this.startTransport();
  }

  private sendPeerPayload(peer: LivePeerSession, payload: string): Promise<boolean> {
    return this.transport.sendToPeer(peer.peerId, payload, peer.epoch);
  }

  private async sendVersionVector(peer?: LivePeerSession): Promise<void> {
    if (!this.engine) return;
    const message: PeerWireVv = { type: 'vv', vector: this.engine.getVersionVector() };
    const json = JSON.stringify(message);
    const peers = peer ? [peer] : [...this.livePeers.values()];
    for (const livePeer of peers) {
      if (livePeer.authenticated) {
        await this.sendPeerPayload(livePeer, json).catch(() => {});
      }
    }
  }

  private async handleTransportEvent(event: TransportEvent): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.init();
      await this.handleTransportEventNow(event);
    });
  }

  private async handleTransportEventNow(event: TransportEvent): Promise<void> {
    if (event.type === 'snapshot') {
      this.transportState = event.state;
      this.transportError = event.error;
      const sessionKeys = new Set(event.peers.map((peer) => peerSessionKey(peer.peerId, peer.epoch)));
      for (const key of this.livePeers.keys()) {
        if (!sessionKeys.has(key)) this.livePeers.delete(key);
      }
      for (const peer of event.peers) {
        await this.handlePeerConnected(peer);
      }
      return;
    }
    if (event.type === 'state') {
      const becameConnected = event.state === 'connected' && this.transportState !== 'connected';
      this.transportState = event.state;
      this.transportError = event.error;
      if (becameConnected) await this.sendVersionVector();
      return;
    }
    if (event.type === 'peer-disconnected') {
      this.livePeers.delete(peerSessionKey(event.peerId, event.epoch));
      return;
    }
    if (event.type === 'peer-channel') {
      const peer = this.livePeers.get(peerSessionKey(event.peerId, event.epoch));
      if (peer) {
        peer.channel = event.channel;
        if (peer.authenticated) await this.sendVersionVector(peer);
        else await this.restartPeerHandshake(peer);
      }
      return;
    }
    if (event.type === 'peer-connected') {
      await this.handlePeerConnected(event);
      return;
    }
    if (event.type === 'peer-message') {
      await this.handlePeerMessage(event.peerId, event.epoch, event.payload);
    }
  }

  private async handlePeerConnected(
    event:
      | Extract<TransportEvent, { type: 'peer-connected' }>
      | Extract<TransportEvent, { type: 'snapshot' }>['peers'][number],
  ): Promise<void> {
    if (!this.device || !this.groupKeys || !this.settings) return;
    const sessionKeys = this.epochGroupKeys.get(event.epoch);
    if (!sessionKeys) return;
    const legacy =
      event.epoch !== this.groupKeys.epoch &&
      this.previousGroupSecrets.some((entry) => entry.epoch === event.epoch);
    if (legacy) {
      const knownMember = this.engine?.getMembers().find((member) => member.deviceId === event.peerId);
      if (!knownMember || !knownMember.agreementAttested || knownMember.removedAt) return;
    }
    const session: LivePeerSession = {
      peerId: event.peerId,
      epoch: event.epoch,
      groupKeys: sessionKeys,
      legacy,
      peerName: event.peerName,
      channel: event.channel,
      ownCertHash: event.ownCertHash,
      peerCertHash: event.peerCertHash,
      authenticated: false,
      proofSent: false,
      rehandshakePending: false,
      lastSeenAt: Date.now(),
    };
    this.livePeers.set(peerSessionKey(event.peerId, event.epoch), session);
    const hello = this.buildOwnHello(session);
    session.ownHello = hello;
    await this.sendPeerPayload(session, JSON.stringify({ type: 'hello', hello }));
  }

  private buildOwnHello(peer: LivePeerSession): HandshakeHello {
    if (!this.device || !this.settings) {
      throw new Error('Sync is not initialized');
    }
    return buildHandshakeHello({
      device: this.device,
      deviceName: this.settings.deviceName,
      epoch: peer.groupKeys.epoch,
      epochEstablished: this.settings.epochEstablished ?? true,
      ownCertHash: peer.ownCertHash,
      peerCertHash: peer.peerCertHash,
    });
  }

  private async restartPeerHandshake(peer: LivePeerSession): Promise<void> {
    peer.authenticated = false;
    peer.proofSent = false;
    peer.rehandshakePending = true;
    const hello = this.buildOwnHello(peer);
    peer.ownHello = hello;
    await this.sendPeerPayload(peer, JSON.stringify({ type: 'hello', hello } satisfies PeerWireHello));
  }

  private removePeerSessions(peerId: string): void {
    for (const [key, peer] of this.livePeers) {
      if (peer.peerId === peerId) this.livePeers.delete(key);
    }
  }

  private rekeyPeerSession(peer: LivePeerSession, epoch: number, keys: GroupKeys): void {
    this.livePeers.delete(peerSessionKey(peer.peerId, peer.epoch));
    peer.epoch = epoch;
    peer.groupKeys = keys;
    peer.legacy = false;
    this.livePeers.set(peerSessionKey(peer.peerId, epoch), peer);
  }

  private async getCertifiedCurrentMemberJoin(): Promise<SyncRecordEnvelope | null> {
    const engine = this.engine;
    const device = this.device;
    const groupKeys = this.groupKeys;
    if (!engine || !device || !groupKeys) return null;
    const signingPublic = toBase64Url(device.signingPublicRaw);
    const agreementPublic = toBase64Url(device.agreementPublicRaw);
    const candidate = [...engine.getAllEnvelopes()].reverse().find(
      (record) =>
        record.deviceId === device.deviceId &&
        record.signingPublic === signingPublic &&
        record.kind === 'member-join' &&
        record.epoch === engine.epoch &&
        record.epoch === groupKeys.epoch,
    );
    if (!candidate) return null;
    try {
      const body = await openRecordBody<SyncRecordBody>(
        groupKeys.recordKey,
        canonicalJson({
          deviceId: candidate.deviceId,
          seq: candidate.seq,
          epoch: candidate.epoch,
          hlc: candidate.hlc,
          configVersion: candidate.configVersion,
          kind: candidate.kind,
        }),
        candidate.nonce,
        candidate.ciphertext,
      );
      if (
        body.kind !== 'member-join' ||
        body.deviceId !== device.deviceId ||
        body.signingPublic !== signingPublic ||
        body.agreementPublic !== agreementPublic
      ) {
        return null;
      }
      const agreementSig = body.agreementSig;
      if (typeof agreementSig !== 'string') return null;
      return (
        (await verifyMemberCertificate({
          deviceId: body.deviceId,
          signingPublic: body.signingPublic,
          agreementPublic: body.agreementPublic,
          agreementSig,
        })) ? candidate : null
      );
    } catch {
      return null;
    }
  }

  private async handlePeerMessage(peerId: string, epoch: number, raw: string): Promise<void> {
    if (!this.engine || !this.device || !this.groupKeys) return;
    const peer = this.livePeers.get(peerSessionKey(peerId, epoch));
    if (!peer) return;
    peer.lastSeenAt = Date.now();

    let msg: PeerWireMessage;
    try {
      msg = JSON.parse(raw) as PeerWireMessage;
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      const remoteHello = msg.hello;
      if (!remoteHello || remoteHello.deviceId !== peerId) return;
      const knownMember = this.engine.getMembers().find((member) => member.deviceId === peerId);
      if (knownMember?.removedAt) {
        this.livePeers.delete(peerSessionKey(peerId, peer.epoch));
        return;
      }
      if (
        peer.legacy &&
        (!knownMember ||
          !knownMember.agreementAttested ||
          knownMember.removedAt ||
          knownMember.signingPublic !== remoteHello.signingPublic)
      ) {
        this.livePeers.delete(peerSessionKey(peerId, peer.epoch));
        return;
      }
      // Verify DTLS certificate channel binding when fingerprints are available.
      if (peer.peerCertHash && remoteHello.ownCertHash && peer.peerCertHash !== remoteHello.ownCertHash) {
        this.livePeers.delete(peerSessionKey(peerId, peer.epoch));
        return;
      }
      const remoteHelloChanged =
        peer.remoteHello !== undefined && JSON.stringify(peer.remoteHello) !== JSON.stringify(remoteHello);
      if (!peer.rehandshakePending && (remoteHelloChanged || peer.proofSent)) {
        await this.restartPeerHandshake(peer);
      } else if (peer.rehandshakePending && remoteHelloChanged) {
        peer.proofSent = false;
      }
      peer.remoteHello = remoteHello;
      peer.peerName = remoteHello.deviceName || peer.peerName;
      if (peer.ownHello && !peer.proofSent) {
        peer.proofSent = true;
        const proof = await createHandshakeProof({
          localHello: peer.ownHello,
          remoteHello,
          device: this.device,
          groupKeys: peer.groupKeys,
          knownPeer: Boolean(knownMember && !knownMember.removedAt),
        });
        await this.sendPeerPayload(peer, JSON.stringify({ type: 'proof', proof } satisfies PeerWireProof));
      }
      return;
    }

    if (msg.type === 'proof') {
      if (!peer.ownHello || !peer.remoteHello) return;
      const knownMember = this.engine.getMembers().find((m) => m.deviceId === peerId);
      if (knownMember?.removedAt) {
        this.livePeers.delete(peerSessionKey(peerId, peer.epoch));
        return;
      }
      if (
        peer.legacy &&
        (!knownMember ||
          !knownMember.agreementAttested ||
          knownMember.removedAt ||
          knownMember.signingPublic !== peer.remoteHello.signingPublic)
      ) {
        this.livePeers.delete(peerSessionKey(peerId, peer.epoch));
        return;
      }

      const check = await verifyHandshakeProof({
        localHello: peer.ownHello,
        remoteHello: peer.remoteHello,
        remoteProof: msg.proof,
        groupKeys: peer.groupKeys,
        knownPeerSigningPublic: knownMember?.signingPublic,
      });
      if (!check.ok) {
        this.livePeers.delete(peerSessionKey(peerId, peer.epoch));
        return;
      }

      await this.promoteGroupEpoch(peer.remoteHello.epoch, peer.remoteHello.epochEstablished !== false);
      if (!peer.legacy && this.groupKeys && peer.epoch !== this.groupKeys.epoch) {
        this.rekeyPeerSession(peer, this.groupKeys.epoch, this.groupKeys);
      }
      peer.authenticated = true;
      peer.rehandshakePending = false;
      await this.persist();

      if (!peer.legacy) {
        const memberJoin =
          (await this.getCertifiedCurrentMemberJoin()) ?? (await this.engine.createMemberJoinRecord());
        const joinMessage: PeerWireRecords = {
          type: 'records',
          envelopes: [memberJoin],
          vector: this.engine.getVersionVector(),
        };
        await this.sendPeerPayload(peer, JSON.stringify(joinMessage));
      }

      // Immediately exchange version vectors.
      const vv: PeerWireVv = { type: 'vv', vector: this.engine.getVersionVector() };
      await this.sendPeerPayload(peer, JSON.stringify(vv));
      return;
    }

    if (!peer.authenticated) return;

    if (msg.type === 'vv') {
      peer.remoteVector = { ...msg.vector };
      await this.engine.recordPeerAck(peerId, msg.vector);
      await this.pruneAcknowledgedPreviousSecrets();
      if (peer.legacy) {
        const envelopes = this.legacyControlCatchup(peer, msg.vector);
        if (envelopes.length) {
          const response: PeerWireRecords = {
            type: 'records',
            envelopes,
            vector: this.engine.getVersionVector(),
          };
          await this.sendPeerPayload(peer, JSON.stringify(response));
        }
        await this.engine.compact();
        await this.persist();
        return;
      }
      const missing = this.engine.missingRecordsFor(msg.vector);
      const localVector = this.engine.getVersionVector();
      const remoteJoinEpoch = this.engine.getMemberJoinEpoch(peerId) ?? peer.remoteHello?.epoch;
      const missingOldEpoch = missing.some((record) => remoteJoinEpoch !== undefined && record.epoch < remoteJoinEpoch);
      const compactedGap = Object.entries(localVector).some(([deviceId, seq]) => {
        const remoteSeq = msg.vector[deviceId] ?? 0;
        if (seq <= remoteSeq) return false;
        const available = missing
          .filter((record) => record.deviceId === deviceId)
          .map((record) => record.seq)
          .sort((a, b) => a - b);
        let expected = remoteSeq + 1;
        for (const availableSeq of available) {
          if (availableSeq < expected) continue;
          if (availableSeq > expected) return true;
          expected += 1;
        }
        return expected <= seq;
      });
      let outgoing = missing.filter(
        (record) => remoteJoinEpoch === undefined || record.epoch >= remoteJoinEpoch,
      );
      if (missingOldEpoch || compactedGap) {
        const snapshot = await this.engine.createSnapshotRecords();
        outgoing = [...outgoing, ...snapshot.records];
        if (snapshot.skippedPaths.length) {
          console.warn('Skipped oversized sync snapshot registers', snapshot.skippedPaths);
        }
      }
      const coveredVector = this.engine.getVersionVector();
      const payload: PeerWireRecords = {
        type: 'records',
        envelopes: outgoing,
        vector: coveredVector,
        coveredVector,
      };
      await this.sendPeerPayload(peer, JSON.stringify(payload));
      await this.engine.compact();
      await this.persist();
      return;
    }

    if (msg.type === 'records') {
      if (peer.legacy) return;
      peer.remoteVector = { ...msg.vector };
      const result = await this.engine.receiveRecords(msg.envelopes);
      if (msg.coveredVector) await this.engine.adoptCoveredVector(msg.coveredVector);
      await this.engine.recordPeerAck(peerId, msg.vector);
      await this.pruneAcknowledgedPreviousSecrets();
      if (msg.coveredVector) {
        const missing = this.engine.missingRecordsFor(msg.vector);
        if (missing.length) {
          const response: PeerWireRecords = {
            type: 'records',
            envelopes: missing,
            vector: this.engine.getVersionVector(),
          };
          await this.sendPeerPayload(peer, JSON.stringify(response)).catch(() => {});
        }
      }

      if (result.epochRotatedTo !== undefined) {
        if (result.groupSecret && this.groupSecret && this.groupKeys) {
          this.retainPreviousGroupSecret(this.groupKeys.epoch, this.groupSecret);
        }
        const rotatedKeys = this.engine.getGroupKeys(result.epochRotatedTo);
        if (rotatedKeys) {
          this.groupKeys = rotatedKeys;
          this.epochGroupKeys.set(rotatedKeys.epoch, rotatedKeys);
          this.epochKeys[rotatedKeys.epoch] = rotatedKeys.recordKey;
        }
      }
      if (result.groupSecret) this.groupSecret = result.groupSecret;

      if (this.pendingInitialJoinSync && this.settings && msg.coveredVector) {
        this.pendingInitialJoinSync = false;
        this.settings.pendingInitialJoinSync = false;
        const config = await loadConfig();
        const storageVals = await browser.storage.local.get(null);
        const localChanges = extractNonDefaultLocalChanges(config, storageVals);
        const resolved = await this.engine.resolveJoinConflict(this.settings.joinConflictMode, localChanges);
        if (resolved.toApplyLocally.length) {
          await this.applyAppliedChanges(resolved.toApplyLocally);
        }
        if (resolved.emitted.length) {
          await this.broadcastEnvelopes(resolved.emitted);
        }
      } else if (!this.pendingInitialJoinSync && result.applied.length) {
        await this.applyAppliedChanges(result.applied);
      }

      this.lastSyncAt = Date.now();
      await this.engine.compact();
      await this.persist();

      const ack: PeerWireAck = { type: 'ack', vector: this.engine.getVersionVector() };
      await this.sendPeerPayload(peer, JSON.stringify(ack));

      if (result.epochRotatedTo !== undefined) {
        await this.startTransport();
      }
      return;
    }

    if (msg.type === 'ack') {
      peer.remoteVector = { ...msg.vector };
      await this.engine.recordPeerAck(peerId, msg.vector);
      await this.pruneAcknowledgedPreviousSecrets();
      await this.engine.compact();
      this.lastSyncAt = Date.now();
      await this.persist();
    }
  }

  private async applyAppliedChanges(applied: readonly import('@kiwi-search/sync').AppliedChange[]): Promise<void> {
    const { configPatches, storageUpdates, storageRemovals } = appliedChangesToLocalUpdates(applied);
    if (configPatches.length) {
      const searxngKey = applied.findLast((change) => change.path === SEARXNG_KEY_PATH);
      await this.applyRemoteConfigPatches(configPatches, searxngKey?.pairedUrl);
    }
    if (Object.keys(storageUpdates).length) {
      await browser.storage.local.set(storageUpdates);
    }
    if (storageRemovals.length) {
      await browser.storage.local.remove(storageRemovals);
    }
  }

  private async reconcileIncludedRegisters(previousCategories: SyncCategorySettings): Promise<boolean> {
    const result = await this.engine!.reconcileIncludedRegisters(
      previousCategories,
      async (paths) => readLocalSyncChanges(paths, await loadConfig(), await browser.storage.local.get(null)),
      this.pendingInitialJoinSync,
    );
    await this.applyAppliedChanges(result.toApplyLocally);
    await this.broadcastEnvelopes(result.emitted);
    return result.reclassified;
  }

  private async backfillLlmSelections(): Promise<SyncRecordEnvelope[]> {
    if (this.pendingInitialJoinSync) return [];
    return this.engine!.backfillLlmSelections(async (paths) => readLocalSyncChanges(paths, await loadConfig(), {}));
  }

  async handleMessage(message: SyncRuntimeMessage): Promise<SyncRuntimeResponse> {
    return this.enqueueMutation(() => this.handleMessageNow(message));
  }

  private async handleMessageNow(message: SyncRuntimeMessage): Promise<SyncRuntimeResponse> {
    await this.init();
    try {
      if (message.type === 'kiwi:sync:status') {
        return { ok: true, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:create-group') {
        const { phrase, entropy } = await generateRecoveryPhrase();
        const device = await generateDeviceKeys();
        const groupSecret = await importGroupSecret(entropy);
        const groupKeys = await deriveGroupKeys(groupSecret, 1);
        const settings: SyncLocalSettings = {
          deviceName: message.deviceName?.trim() || defaultDeviceName(),
          relayUrl: message.relayUrl?.trim() ?? this.connectionDefaults.relayUrl,
          stunEnabled: message.stunEnabled ?? this.connectionDefaults.stunEnabled,
          stunUrls: message.stunUrls ?? this.connectionDefaults.stunUrls,
          categories: { ...DEFAULT_SYNC_CATEGORIES },
          joinConflictMode: 'group',
          epochEstablished: true,
          pendingInitialJoinSync: false,
        };
        this.device = device;
        this.groupSecret = groupSecret;
        this.groupKeys = groupKeys;
        this.epochGroupKeys.clear();
        this.epochGroupKeys.set(groupKeys.epoch, groupKeys);
        this.previousGroupSecrets = [];
        this.epochKeys = { 1: groupKeys.recordKey };
        this.settings = settings;
        this.livePeers.clear();
        this.pendingInitialJoinSync = false;
        this.engine = new SyncEngine({
          device,
          deviceName: settings.deviceName,
          groupKeys,
          configVersion: CONFIG_VERSION,
          categories: settings.categories,
        });

        // Seed initial non-default local settings (excluding keys unless enabled).
        const config = await loadConfig();
        const storageVals = await browser.storage.local.get(null);
        const initialChanges = extractNonDefaultLocalChanges(config, storageVals);
        if (initialChanges.length) {
          await this.engine.applyLocalChanges(initialChanges);
        }

        await this.persist();
        try {
          await this.startTransport();
        } catch (error) {
          this.transportState = 'error';
          this.transportError = error instanceof Error ? error.message : String(error);
        }
        return { ok: true, phrase, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:join-group') {
        const entropy = await phraseToEntropy(message.phrase);
        const device = await generateDeviceKeys();
        const groupSecret = await importGroupSecret(entropy);
        const groupKeys = await deriveGroupKeys(groupSecret, 1);
        const settings: SyncLocalSettings = {
          deviceName: message.deviceName?.trim() || defaultDeviceName(),
          relayUrl: message.relayUrl?.trim() ?? this.connectionDefaults.relayUrl,
          stunEnabled: message.stunEnabled ?? this.connectionDefaults.stunEnabled,
          stunUrls: message.stunUrls ?? this.connectionDefaults.stunUrls,
          categories: { ...DEFAULT_SYNC_CATEGORIES },
          joinConflictMode: message.conflictMode ?? 'group',
          epochEstablished: false,
          pendingInitialJoinSync: true,
        };
        this.device = device;
        this.groupSecret = groupSecret;
        this.groupKeys = groupKeys;
        this.epochGroupKeys.clear();
        this.epochGroupKeys.set(groupKeys.epoch, groupKeys);
        this.previousGroupSecrets = [];
        this.epochKeys = { 1: groupKeys.recordKey };
        this.settings = settings;
        this.livePeers.clear();
        this.pendingInitialJoinSync = true;
        this.engine = new SyncEngine({
          device,
          deviceName: settings.deviceName,
          groupKeys,
          configVersion: CONFIG_VERSION,
          categories: settings.categories,
        });

        await this.persist();
        await this.startTransport();
        return { ok: true, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:leave-group') {
        await this.transport.stop();
        if (this.settings) {
          const { relayUrl, stunEnabled, stunUrls } = this.settings;
          const connection = { relayUrl, stunEnabled, stunUrls };
          await browser.storage.local.set({ syncConnection: connection });
          this.connectionDefaults = connection;
        }
        await this.storage.clear();
        this.engine = null;
        this.device = null;
        this.groupSecret = null;
        this.groupKeys = null;
        this.epochGroupKeys.clear();
        this.previousGroupSecrets = [];
        this.epochKeys = {};
        this.settings = null;
        this.livePeers.clear();
        this.transportState = 'idle';
        this.transportError = undefined;
        this.lastSyncAt = undefined;
        return { ok: true, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:update-settings') {
        if (!this.engine || !this.settings) {
          if (message.relayUrl === undefined || message.categories || message.deviceName !== undefined) {
            return { ok: false, error: 'Sync is not enabled' };
          }
          const connection = {
            relayUrl: message.relayUrl.trim(),
            stunEnabled: message.stunEnabled ?? this.connectionDefaults.stunEnabled,
            stunUrls: message.stunUrls ?? this.connectionDefaults.stunUrls,
          };
          await browser.storage.local.set({ syncConnection: connection });
          this.connectionDefaults = connection;
          return { ok: true, status: this.getStatus() };
        }
        const previousCategories = this.settings.categories;

        if (message.deviceName !== undefined && message.deviceName.trim()) {
          this.settings.deviceName = message.deviceName.trim();
        }
        if (message.relayUrl !== undefined) {
          this.settings.relayUrl = message.relayUrl.trim();
        }
        if (message.stunEnabled !== undefined) {
          this.settings.stunEnabled = message.stunEnabled;
        }
        if (message.stunUrls !== undefined) {
          this.settings.stunUrls = message.stunUrls.filter((u) => u.trim()).map((u) => u.trim());
        }
        if (message.categories) {
          this.settings.categories = {
            ...this.settings.categories,
            ...message.categories,
          };
          await this.engine.setCategories(this.settings.categories);
          await this.reconcileIncludedRegisters(previousCategories);
          const backfilled = await this.backfillLlmSelections();
          if (backfilled.length) await this.broadcastEnvelopes(backfilled);
        }

        // Publish pre-existing local keys that have never been registered.
        if (!previousCategories.keys && this.settings.categories.keys) {
          const registers = this.engine.getRegisters();
          const config = await loadConfig();
          const storageVals = await browser.storage.local.get(null);
          const localKeyChanges = extractNonDefaultLocalChanges(config, storageVals).filter(
            (c) => classifySyncPath(c.path) === 'keys' && !registers[c.path],
          );
          if (localKeyChanges.length) {
            const emitted = await this.engine.applyLocalChanges(localKeyChanges);
            if (emitted.length) await this.broadcastEnvelopes(emitted);
          }
        }

        await this.persist();

        await this.startTransport();

        return { ok: true, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:sync-now') {
        if (!this.engine || !this.settings) return { ok: false, error: 'Sync is not enabled' };
        if (this.settings.relayUrl && this.transportState !== 'connected') {
          await this.startTransport();
        }
        const vv: PeerWireVv = { type: 'vv', vector: this.engine.getVersionVector() };
        const json = JSON.stringify(vv);
        for (const peer of this.livePeers.values()) {
          if (peer.authenticated) {
            await this.sendPeerPayload(peer, json).catch(() => {});
          } else {
            await this.restartPeerHandshake(peer).catch(() => {});
          }
        }
        return { ok: true, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:remove-device') {
        if (!this.engine || !this.groupSecret || !this.groupKeys) return { ok: false, error: 'Sync is not enabled' };
        const { phrase, entropy } = await generateRecoveryPhrase();
        const { envelope, newGroupKeys } = await this.engine.removeDevice(message.deviceId, entropy);
        await this.broadcastEnvelopes([envelope]);
        this.retainPreviousGroupSecret(this.groupKeys.epoch, this.groupSecret);
        this.groupSecret = await importGroupSecret(entropy);
        this.groupKeys = newGroupKeys;
        this.epochGroupKeys.set(newGroupKeys.epoch, newGroupKeys);
        this.epochKeys[newGroupKeys.epoch] = newGroupKeys.recordKey;
        this.removePeerSessions(message.deviceId);
        await this.persist();
        await this.startTransport();
        return { ok: true, phrase, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:rotate-phrase') {
        if (!this.engine || !this.groupSecret || !this.groupKeys) return { ok: false, error: 'Sync is not enabled' };
        const { phrase, entropy } = await generateRecoveryPhrase();
        const { envelope, newGroupKeys } = await this.engine.rotatePhrase(entropy);
        await this.broadcastEnvelopes([envelope]);
        this.retainPreviousGroupSecret(this.groupKeys.epoch, this.groupSecret);
        this.groupSecret = await importGroupSecret(entropy);
        this.groupKeys = newGroupKeys;
        this.epochGroupKeys.set(newGroupKeys.epoch, newGroupKeys);
        this.epochKeys[newGroupKeys.epoch] = newGroupKeys.recordKey;
        await this.persist();
        await this.startTransport();
        return { ok: true, phrase, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:create-code') {
        if (!this.engine || !this.settings) return { ok: false, error: 'Sync is not enabled' };
        if (message.kind === 'answer' && this.groupKeys) {
          const offer = await decodeConnectionCode(this.groupKeys, message.offerCode ?? '');
          await this.promoteGroupEpoch(offer.epoch);
        }
        const code =
          message.kind === 'offer'
            ? await this.transport.createOfferCode()
            : await this.transport.createAnswerCode(message.offerCode ?? '');
        return { ok: true, code, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:accept-code') {
        if (!this.engine || !this.settings) return { ok: false, error: 'Sync is not enabled' };
        if (this.groupKeys) {
          const answer = await decodeConnectionCode(this.groupKeys, message.code);
          await this.promoteGroupEpoch(answer.epoch);
        }
        await this.transport.acceptAnswerCode(message.code);
        return { ok: true, status: this.getStatus() };
      }

      return { ok: false, error: 'Unknown sync message' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
