import { CONFIG_VERSION } from '@kiwi-search/core';
import {
  DEFAULT_SYNC_CATEGORIES,
  SyncEngine,
  buildHandshakeHello,
  createHandshakeProof,
  decodeConnectionCode,
  deriveGroupKeys,
  generateDeviceKeys,
  generateRecoveryPhrase,
  importGroupSecret,
  phraseToEntropy,
  verifyHandshakeProof,
  type DeviceKeys,
  type GroupKeys,
  type HandshakeHello,
  type HandshakeProof,
  type LocalChangeInput,
  type SyncRecordEnvelope,
  type VersionVector,
} from '@kiwi-search/sync';
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
  type StoredSyncRecord,
  type SyncLocalSettings,
  type SyncStorageAdapter,
} from './syncDb';
import {
  appliedChangesToLocalUpdates,
  extractNonDefaultLocalChanges,
  uiStorageChangesToSyncChanges,
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
  peerName: string;
  channel: SyncPeerChannel;
  ownCertHash: string;
  peerCertHash: string;
  ownHello?: HandshakeHello;
  remoteHello?: HandshakeHello;
  authenticated: boolean;
  proofSent: boolean;
  lastSeenAt: number;
}

export interface SyncServiceDeps {
  storage?: SyncStorageAdapter;
  transportFactory?: (onEvent: (event: TransportEvent) => void) => SyncTransport;
  applyRemoteConfigPatches: (patches: SettingsPatch[]) => Promise<void>;
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
  private readonly applyRemoteConfigPatches: (patches: SettingsPatch[]) => Promise<void>;

  private engine: SyncEngine | null = null;
  private device: DeviceKeys | null = null;
  private groupSecret: CryptoKey | null = null;
  private groupKeys: GroupKeys | null = null;
  private epochKeys: Record<number, CryptoKey> = {};
  private settings: SyncLocalSettings | null = null;

  private transportState: SyncTransportState = 'idle';
  private transportError: string | undefined;
  private lastSyncAt: number | undefined;
  private livePeers = new Map<string, LivePeerSession>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private pendingInitialJoinSync = false;

  /** Keys currently being written by remote sync so storage.onChanged does not echo them. */
  private suppressedStorageKeys = new Set<string>();

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
        if (stored) {
          this.device = stored.device;
          this.groupSecret = stored.groupSecret;
          this.groupKeys = stored.groupKeys;
          this.epochKeys = { ...stored.epochKeys };
          this.settings = stored.settings;
          this.engine = new SyncEngine({
            device: stored.device,
            deviceName: stored.settings.deviceName,
            groupKeys: stored.groupKeys,
            configVersion: CONFIG_VERSION,
            categories: stored.settings.categories,
            persisted: stored.engineState,
          });
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
      settings: this.settings,
      engineState: this.engine.exportState(),
    };
    await this.storage.save(record);
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
    await this.transport.start({
      deviceId: this.device.deviceId,
      deviceName: this.settings.deviceName,
      epoch: this.groupKeys.epoch,
      relayUrl: this.settings.relayUrl,
      stunEnabled: this.settings.stunEnabled,
      stunUrls: this.settings.stunUrls,
    });
  }

  private async promoteGroupEpoch(epoch: number): Promise<void> {
    if (!this.engine || !this.groupSecret || !this.groupKeys || epoch <= this.groupKeys.epoch) return;
    if (this.engine.hasAcceptedRecords()) return;
    const keys = await deriveGroupKeys(this.groupSecret, epoch);
    this.groupKeys = keys;
    this.epochKeys[epoch] = keys.recordKey;
    this.engine.registerEpochKeys(keys);
    await this.persist();
    await this.startTransport();
  }

  getStatus(): SyncStatusSnapshot {
    if (!this.engine || !this.device || !this.groupKeys || !this.settings) {
      return {
        enabled: false,
        deviceId: null,
        deviceName: defaultDeviceName(),
        epoch: 0,
        relayUrl: '',
        stunEnabled: false,
        stunUrls: [...DEFAULT_STUN_URLS],
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
      const live = this.livePeers.get(member.deviceId);
      peerList.push({
        deviceId: member.deviceId,
        deviceName: live?.peerName || member.deviceName || member.deviceId.slice(0, 8),
        status: member.removedAt ? 'removed' : live ? 'online' : 'offline',
        channel: live?.channel ?? 'none',
        lastSeenAt: live?.lastSeenAt ?? member.lastSeenAt ?? member.joinedAt,
        certFingerprint: live?.peerCertHash || undefined,
      });
    }
    for (const live of this.livePeers.values()) {
      if (state.members[live.peerId]) continue;
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
    if (!emitted.length) return;
    await this.persist();
    await this.broadcastEnvelopes(emitted);
  }

  /** Record UI preference changes from chrome.storage.onChanged while ignoring our own remote writes. */
  async handleStorageChanged(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): Promise<void> {
    return this.enqueueMutation(() => this.handleStorageChangedNow(changes));
  }

  private async handleStorageChangedNow(
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  ): Promise<void> {
    await this.init();
    if (!this.engine) return;
    const filtered: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (this.suppressedStorageKeys.has(key)) continue;
      filtered[key] = value;
    }
    const localChanges = uiStorageChangesToSyncChanges(filtered);
    if (!localChanges.length) return;
    await this.recordLocalChangesNow(localChanges);
  }

  private async broadcastEnvelopes(envelopes: readonly SyncRecordEnvelope[]): Promise<void> {
    if (!this.engine || !envelopes.length) return;
    const msg: PeerWireRecords = {
      type: 'records',
      envelopes: [...envelopes],
      vector: this.engine.getVersionVector(),
    };
    const json = JSON.stringify(msg);
    for (const peer of this.livePeers.values()) {
      if (peer.authenticated) {
        await this.transport.sendToPeer(peer.peerId, json).catch(() => {});
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
      const peerIds = new Set(event.peers.map((peer) => peer.peerId));
      for (const peerId of this.livePeers.keys()) {
        if (!peerIds.has(peerId)) this.livePeers.delete(peerId);
      }
      for (const peer of event.peers) {
        await this.handlePeerConnected(peer);
      }
      return;
    }
    if (event.type === 'state') {
      this.transportState = event.state;
      this.transportError = event.error;
      return;
    }
    if (event.type === 'peer-disconnected') {
      this.livePeers.delete(event.peerId);
      return;
    }
    if (event.type === 'peer-connected') {
      await this.handlePeerConnected(event);
      return;
    }
    if (event.type === 'peer-message') {
      await this.handlePeerMessage(event.peerId, event.payload);
    }
  }

  private async handlePeerConnected(
    event:
      | Extract<TransportEvent, { type: 'peer-connected' }>
      | Extract<TransportEvent, { type: 'snapshot' }>['peers'][number],
  ): Promise<void> {
    if (!this.device || !this.groupKeys || !this.settings) return;
    const session: LivePeerSession = {
      peerId: event.peerId,
      peerName: event.peerName,
      channel: event.channel,
      ownCertHash: event.ownCertHash,
      peerCertHash: event.peerCertHash,
      authenticated: false,
      proofSent: false,
      lastSeenAt: Date.now(),
    };
    this.livePeers.set(event.peerId, session);
    const hello = buildHandshakeHello({
      device: this.device,
      deviceName: this.settings.deviceName,
      epoch: this.groupKeys.epoch,
      ownCertHash: event.ownCertHash,
      peerCertHash: event.peerCertHash,
    });
    session.ownHello = hello;
    await this.transport.sendToPeer(event.peerId, JSON.stringify({ type: 'hello', hello } satisfies PeerWireHello));
  }

  private async handlePeerMessage(peerId: string, raw: string): Promise<void> {
    if (!this.engine || !this.device || !this.groupKeys) return;
    const peer = this.livePeers.get(peerId);
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
      // Verify DTLS certificate channel binding when fingerprints are available.
      if (peer.peerCertHash && remoteHello.ownCertHash && peer.peerCertHash !== remoteHello.ownCertHash) {
        this.livePeers.delete(peerId);
        return;
      }
      peer.remoteHello = remoteHello;
      peer.peerName = remoteHello.deviceName || peer.peerName;
      if (peer.ownHello && !peer.proofSent) {
        peer.proofSent = true;
        const knownMember = this.engine.getMembers().find((m) => m.deviceId === peerId);
        const proof = await createHandshakeProof({
          localHello: peer.ownHello,
          remoteHello,
          device: this.device,
          groupKeys: this.groupKeys,
          knownPeer: Boolean(knownMember && !knownMember.removedAt),
        });
        await this.transport.sendToPeer(peerId, JSON.stringify({ type: 'proof', proof } satisfies PeerWireProof));
      }
      return;
    }

    if (msg.type === 'proof') {
      if (!peer.ownHello || !peer.remoteHello) return;
      const knownMember = this.engine.getMembers().find((m) => m.deviceId === peerId);
      if (knownMember?.removedAt) {
        this.livePeers.delete(peerId);
        return;
      }

      const check = await verifyHandshakeProof({
        localHello: peer.ownHello,
        remoteHello: peer.remoteHello,
        remoteProof: msg.proof,
        groupKeys: this.groupKeys,
        knownPeerSigningPublic: knownMember?.signingPublic,
      });
      if (!check.ok) {
        this.livePeers.delete(peerId);
        return;
      }

      await this.promoteGroupEpoch(peer.remoteHello.epoch);
      peer.authenticated = true;
      const memberJoin = this.engine.getAllEnvelopes().find(
        (record) =>
          record.deviceId === this.device!.deviceId &&
          record.kind === 'member-join' &&
          record.epoch === this.groupKeys!.epoch,
      ) ?? await this.engine.createMemberJoinRecord();
      await this.persist();

      const joinMessage: PeerWireRecords = {
        type: 'records',
        envelopes: [memberJoin],
        vector: this.engine.getVersionVector(),
      };
      await this.transport.sendToPeer(peerId, JSON.stringify(joinMessage));

      // Immediately exchange version vectors.
      const vv: PeerWireVv = { type: 'vv', vector: this.engine.getVersionVector() };
      await this.transport.sendToPeer(peerId, JSON.stringify(vv));
      return;
    }

    if (!peer.authenticated) return;

    if (msg.type === 'vv') {
      this.engine.recordPeerAck(peerId, msg.vector);
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
        outgoing = [...outgoing, ...(await this.engine.createSnapshotRecords())];
      }
      const coveredVector = this.engine.getVersionVector();
      const payload: PeerWireRecords = {
        type: 'records',
        envelopes: outgoing,
        vector: coveredVector,
        coveredVector,
      };
      await this.transport.sendToPeer(peerId, JSON.stringify(payload));
      this.engine.compact();
      await this.persist();
      return;
    }

    if (msg.type === 'records') {
      const result = await this.engine.receiveRecords(msg.envelopes);
      if (msg.coveredVector) this.engine.adoptCoveredVector(msg.coveredVector);
      this.engine.recordPeerAck(peerId, msg.vector);

      if (result.groupSecret) this.groupSecret = result.groupSecret;
      if (result.epochRotatedTo !== undefined) {
        const rotatedKeys = this.engine.getGroupKeys(result.epochRotatedTo);
        if (rotatedKeys) {
          this.groupKeys = rotatedKeys;
          this.epochKeys[rotatedKeys.epoch] = rotatedKeys.recordKey;
        }
      }

      if (this.pendingInitialJoinSync && this.settings && msg.coveredVector) {
        this.pendingInitialJoinSync = false;
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
      } else if (result.applied.length) {
        await this.applyAppliedChanges(result.applied);
      }

      this.lastSyncAt = Date.now();
      this.engine.compact();
      await this.persist();

      const ack: PeerWireAck = { type: 'ack', vector: this.engine.getVersionVector() };
      await this.transport.sendToPeer(peerId, JSON.stringify(ack));

      if (result.epochRotatedTo !== undefined) {
        await this.startTransport();
      }
      return;
    }

    if (msg.type === 'ack') {
      this.engine.recordPeerAck(peerId, msg.vector);
      this.engine.compact();
      this.lastSyncAt = Date.now();
      await this.persist();
    }
  }

  private async applyAppliedChanges(applied: readonly import('@kiwi-search/sync').AppliedChange[]): Promise<void> {
    const { configPatches, storageUpdates, storageRemovals } = appliedChangesToLocalUpdates(applied);
    if (configPatches.length) {
      await this.applyRemoteConfigPatches(configPatches);
    }
    const keysToSuppress = [...Object.keys(storageUpdates), ...storageRemovals];
    if (keysToSuppress.length) {
      for (const k of keysToSuppress) this.suppressedStorageKeys.add(k);
      try {
        if (Object.keys(storageUpdates).length) {
          await browser.storage.local.set(storageUpdates);
        }
        if (storageRemovals.length) {
          await browser.storage.local.remove(storageRemovals);
        }
      } finally {
        setTimeout(() => {
          for (const k of keysToSuppress) this.suppressedStorageKeys.delete(k);
        }, 500);
      }
    }
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
          relayUrl: (message.relayUrl ?? '').trim(),
          stunEnabled: Boolean(message.stunEnabled),
          stunUrls: message.stunUrls?.length ? message.stunUrls : [...DEFAULT_STUN_URLS],
          categories: { ...DEFAULT_SYNC_CATEGORIES },
          joinConflictMode: 'group',
        };
        this.device = device;
        this.groupSecret = groupSecret;
        this.groupKeys = groupKeys;
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
          relayUrl: (message.relayUrl ?? '').trim(),
          stunEnabled: Boolean(message.stunEnabled),
          stunUrls: message.stunUrls?.length ? message.stunUrls : [...DEFAULT_STUN_URLS],
          categories: { ...DEFAULT_SYNC_CATEGORIES },
          joinConflictMode: message.conflictMode ?? 'group',
        };
        this.device = device;
        this.groupSecret = groupSecret;
        this.groupKeys = groupKeys;
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
        await this.storage.clear();
        this.engine = null;
        this.device = null;
        this.groupSecret = null;
        this.groupKeys = null;
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
          return { ok: false, error: 'Sync is not enabled' };
        }
        const prevKeysEnabled = this.settings.categories.keys;

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
          this.engine.setCategories(this.settings.categories);
        }

        // If the user just explicitly enabled `keys` on this device:
        // 1) Apply any already-received remote key registers that were stored but skipped earlier.
        // 2) Publish this device's existing non-default API keys/endpoints if any.
        if (!prevKeysEnabled && this.settings.categories.keys) {
          const remoteKeys = this.engine.exportState().registers;
          const toApply = Object.values(remoteKeys)
            .filter((r) => r.category === 'keys' && r.deviceId !== this.device?.deviceId)
            .map((r) => ({ path: r.path, value: r.value, tombstone: r.tombstone, category: 'keys' as const }));
          if (toApply.length) {
            await this.applyAppliedChanges(toApply);
          }
          const config = await loadConfig();
          const storageVals = await browser.storage.local.get(null);
          const localKeyChanges = extractNonDefaultLocalChanges(config, storageVals).filter(
            (c) =>
              c.path.includes('apiKey') ||
              c.path.endsWith('.endpoint') ||
              c.path.endsWith('.baseUrl') ||
              c.path.endsWith('.url'),
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
            await this.transport.sendToPeer(peer.peerId, json).catch(() => {});
          }
        }
        return { ok: true, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:remove-device') {
        if (!this.engine || !this.groupKeys) return { ok: false, error: 'Sync is not enabled' };
        const { phrase, entropy } = await generateRecoveryPhrase();
        const { envelope, newGroupKeys } = await this.engine.removeDevice(message.deviceId, entropy);
        await this.broadcastEnvelopes([envelope]);
        this.groupSecret = await importGroupSecret(entropy);
        this.groupKeys = newGroupKeys;
        this.epochKeys[newGroupKeys.epoch] = newGroupKeys.recordKey;
        this.livePeers.delete(message.deviceId);
        await this.persist();
        await this.startTransport();
        return { ok: true, phrase, status: this.getStatus() };
      }

      if (message.type === 'kiwi:sync:rotate-phrase') {
        if (!this.engine || !this.groupKeys) return { ok: false, error: 'Sync is not enabled' };
        const { phrase, entropy } = await generateRecoveryPhrase();
        const { envelope, newGroupKeys } = await this.engine.rotatePhrase(entropy);
        await this.broadcastEnvelopes([envelope]);
        this.groupSecret = await importGroupSecret(entropy);
        this.groupKeys = newGroupKeys;
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
