import { DEFAULT_CONFIG } from '@kiwi-search/core';
import { DEFAULT_SYNC_RELAY_URL, preferenceKeys, storageKey } from '@kiwi-search/protocol';
import { classifySyncPath, decodeConnectionCode, encodeConnectionCode } from '@kiwi-search/sync';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: storage.get,
        set: storage.set,
        remove: storage.remove,
      },
    },
  },
}));

import { applySettingsPatch, type SettingsPatch } from '../lib/configUpdates';
import { MemorySyncStorage } from '../lib/syncDb';
import {
  appliedChangesToLocalUpdates,
  domainTransitionToSyncChanges,
  settingsPatchesToSyncChanges,
  uiStorageChangesToSyncChanges,
} from '../lib/syncMapping';
import { SyncService } from '../lib/syncService';
import type { SyncTransport } from '../lib/syncTransportBridge';
import type { TransportConfig, TransportEvent } from '../lib/syncTransportCore';

class MockMeshBus {
  private nodes = new Map<string, { onEvent: (ev: TransportEvent) => void; connected: Set<string> }>();
  readonly sentMessages: Array<{ from: string; to: string; payload: string }> = [];
  holdCoveredRecords = false;
  private heldCoveredMessages: Array<{ from: string; to: string; payload: string }> = [];

  createTransport(onEvent: (ev: TransportEvent) => void, shouldStart: (config: TransportConfig) => boolean = () => true): SyncTransport {
    let myId = '';
    const bus = this;
    return {
      async start(config: TransportConfig) {
        if (!shouldStart(config)) return;
        myId = config.deviceId;
        const existing = bus.nodes.get(myId);
        if (existing) existing.onEvent = onEvent;
        else bus.nodes.set(myId, { onEvent, connected: new Set() });
        onEvent({ type: 'state', state: 'connected' });
        // Connect to all existing peers on the bus.
        for (const [peerId, peer] of bus.nodes) {
          if (peerId === myId) continue;
          bus.connectPair(myId, peerId);
          void peer;
        }
      },
      async stop() {
        if (!myId) return;
        const self = bus.nodes.get(myId);
        if (self) {
          for (const peerId of self.connected) {
            const peer = bus.nodes.get(peerId);
            peer?.connected.delete(myId);
            peer?.onEvent({ type: 'peer-disconnected', peerId: myId });
          }
        }
        bus.nodes.delete(myId);
        onEvent({ type: 'state', state: 'idle' });
      },
      async sendToPeer(peerId: string, payload: string) {
        bus.sentMessages.push({ from: myId, to: peerId, payload });
        const peer = bus.nodes.get(peerId);
        if (!peer || !peer.connected.has(myId)) return false;
        const message = JSON.parse(payload) as { type?: string; coveredVector?: unknown };
        if (bus.holdCoveredRecords && message.type === 'records' && message.coveredVector) {
          bus.heldCoveredMessages.push({ from: myId, to: peerId, payload });
          return true;
        }
        queueMicrotask(() => peer.onEvent({ type: 'peer-message', peerId: myId, payload }));
        return true;
      },
      async broadcast(payload: string) {
        const self = bus.nodes.get(myId);
        if (!self) return;
        for (const peerId of self.connected) {
          const peer = bus.nodes.get(peerId);
          if (peer) queueMicrotask(() => peer.onEvent({ type: 'peer-message', peerId: myId, payload }));
        }
      },
      async createOfferCode() {
        return 'kiwi1-mock-offer';
      },
      async createAnswerCode() {
        return 'kiwi1-mock-answer';
      },
      async acceptAnswerCode() {},
      attachOffscreenPort() {},
    };
  }

  connectPair(aId: string, bId: string): void {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b || a.connected.has(bId)) return;
    a.connected.add(bId);
    b.connected.add(aId);
    a.onEvent({ type: 'peer-connected', peerId: bId, peerName: bId, channel: 'webrtc', ownCertHash: `cert-${aId}`, peerCertHash: `cert-${bId}` });
    b.onEvent({ type: 'peer-connected', peerId: aId, peerName: aId, channel: 'webrtc', ownCertHash: `cert-${bId}`, peerCertHash: `cert-${aId}` });
  }

  releaseCoveredRecords(): void {
    for (const { from, to, payload } of this.heldCoveredMessages.splice(0)) {
      const peer = this.nodes.get(to);
      if (peer?.connected.has(from)) {
        queueMicrotask(() => peer.onEvent({ type: 'peer-message', peerId: from, payload }));
      }
    }
  }

  get heldCoveredCount(): number {
    return this.heldCoveredMessages.length;
  }
}

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  storage.value = { config: structuredClone(DEFAULT_CONFIG) };
  storage.get.mockReset().mockImplementation(async () => structuredClone(storage.value));
  storage.set.mockReset().mockImplementation(async (patch) => {
    Object.assign(storage.value, structuredClone(patch));
  });
  storage.remove.mockReset().mockImplementation(async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete storage.value[k];
  });
});

describe('syncMapping', () => {
  it('classifies every syncable default config leaf and UI storage key', () => {
    const leaves: string[] = [];
    const walk = (prefix: string, value: unknown): void => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, nested] of Object.entries(value)) {
          if (prefix === 'config' && key === 'version') continue;
          walk(`${prefix}.${key}`, nested);
        }
      } else {
        leaves.push(prefix);
      }
    };
    walk('config', DEFAULT_CONFIG);

    for (const path of [...leaves, ...preferenceKeys.map(storageKey), 'academicLanguage']) {
      expect(classifySyncPath(path), path).not.toBeNull();
    }
    for (const path of leaves.filter((path) => /\.(apiKey|baseUrl|endpoint)$/.test(path))) {
      expect(classifySyncPath(path), path).toBe('keys');
    }
    expect(classifySyncPath('bridge.mcpToken')).toBeNull();
    expect(classifySyncPath('config.bridge.mcpPort')).toBeNull();
    expect(classifySyncPath('mcp.pairingToken')).toBeNull();
  });

  it('maps scalar, membership set, tombstone, and UI storage changes round-trip', () => {
    const patches: SettingsPatch[] = [
      { path: ['summary', 'enabled'], value: false },
      { path: ['judge', 'blockedDomains'], add: ['spam.example'], subtract: ['old.example'] },
    ];
    const changes = settingsPatchesToSyncChanges(patches);
    expect(changes).toContainEqual({ path: 'config.summary.enabled', value: false });
    expect(changes).toContainEqual({ path: 'config.judge.blockedDomains#spam.example', value: true });
    expect(changes).toContainEqual({ path: 'config.judge.blockedDomains#old.example', tombstone: true });

    const domChanges = domainTransitionToSyncChanges(
      'docs.example',
      { blocked: false, boosted: false },
      { blocked: false, boosted: true },
    );
    expect(domChanges).toEqual([{ path: 'config.judge.boostedDomains#docs.example', value: true }]);

    const themeKey = storageKey('theme');
    const uiChanges = uiStorageChangesToSyncChanges({
      [themeKey]: { oldValue: 'auto', newValue: 'dark' },
      unrelatedKey: { oldValue: 1, newValue: 2 },
    });
    expect(uiChanges).toEqual([{ path: themeKey, value: 'dark' }]);

    const localUpdates = appliedChangesToLocalUpdates([
      { path: 'config.summary.enabled', value: false, tombstone: false, category: 'search' },
      { path: 'config.judge.blockedDomains#spam.example', value: true, tombstone: false, category: 'filters' },
      { path: 'config.judge.blockedDomains#old.example', tombstone: true, category: 'filters' },
      { path: themeKey, value: 'dark', tombstone: false, category: 'ui' },
    ]);
    expect(localUpdates.configPatches).toContainEqual({ path: ['summary', 'enabled'], value: false });
    expect(localUpdates.configPatches).toContainEqual({
      path: ['judge', 'blockedDomains'],
      add: ['spam.example'],
      subtract: ['old.example'],
    });
    expect(localUpdates.storageUpdates).toEqual({ [themeKey]: 'dark' });
  });

  it('coalesces membership changes by full path and keeps the last change', () => {
    const addThenRemove = appliedChangesToLocalUpdates([
      { path: 'config.judge.blockedDomains#example.test', value: true, tombstone: false, category: 'filters' },
      { path: 'config.judge.blockedDomains#example.test', tombstone: true, category: 'filters' },
    ]);
    expect(addThenRemove.configPatches).toEqual([
      { path: ['judge', 'blockedDomains'], add: [], subtract: ['example.test'] },
    ]);

    const removeThenAdd = appliedChangesToLocalUpdates([
      { path: 'config.judge.blockedDomains#example.test', tombstone: true, category: 'filters' },
      { path: 'config.judge.blockedDomains#example.test', value: true, tombstone: false, category: 'filters' },
    ]);
    expect(removeThenAdd.configPatches).toEqual([
      { path: ['judge', 'blockedDomains'], add: ['example.test'], subtract: [] },
    ]);
  });
});

describe('SyncService multi-device integration', () => {
  it('defaults an omitted relay URL and reports it before a group exists', async () => {
    const store = new MemorySyncStorage();
    const service = new SyncService({
      storage: store,
      transportFactory: (cb) => new MockMeshBus().createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });

    const status = await service.handleMessage({ type: 'kiwi:sync:status' });
    expect(status.ok && status.status.relayUrl).toBe(DEFAULT_SYNC_RELAY_URL);

    const created = await service.handleMessage({ type: 'kiwi:sync:create-group' });
    expect(created.ok).toBe(true);
    expect((await store.load())?.settings.relayUrl).toBe(DEFAULT_SYNC_RELAY_URL);
  });

  it('keeps an explicitly empty relay URL for codes-only pairing', async () => {
    const store = new MemorySyncStorage();
    const service = new SyncService({
      storage: store,
      transportFactory: (cb) => new MockMeshBus().createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });

    const created = await service.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: '' });
    expect(created.ok).toBe(true);
    expect((await store.load())?.settings.relayUrl).toBe('');
  });

  it('re-handshakes after a service worker restarts with an existing peer snapshot', async () => {
    const bus = new MockMeshBus();
    const storeA = new MemorySyncStorage();
    const storeD = new MemorySyncStorage();
    const stateD = { config: structuredClone(DEFAULT_CONFIG) };
    const svcA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });
    const svcD = new SyncService({
      storage: storeD,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        stateD.config = applySettingsPatch(stateD.config, patches);
      },
    });

    const created = await svcA.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: 'wss://relay.local' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const joined = await svcD.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: created.phrase!,
      relayUrl: 'wss://relay.local',
    });
    expect(joined.ok).toBe(true);
    await flushMicrotasks();

    const helloCount = () =>
      bus.sentMessages.filter(({ payload }) => (JSON.parse(payload) as { type: string }).type === 'hello').length;
    const previousHelloCount = helloCount();
    const deviceA = svcA.getStatus().deviceId!;
    const deviceD = svcD.getStatus().deviceId!;
    let onRestartedDEvent: ((event: TransportEvent) => void) | undefined;
    const restartedD = new SyncService({
      storage: storeD,
      transportFactory: (cb) => {
        onRestartedDEvent = cb;
        return bus.createTransport(cb);
      },
      applyRemoteConfigPatches: async (patches) => {
        stateD.config = applySettingsPatch(stateD.config, patches);
      },
    });
    await restartedD.init();
    expect(onRestartedDEvent).toBeDefined();
    if (!onRestartedDEvent) return;

    onRestartedDEvent({
      type: 'snapshot',
      state: 'connected',
      peers: [{
        peerId: deviceA,
        peerName: 'Device A',
        channel: 'webrtc',
        ownCertHash: `cert-${deviceD}`,
        peerCertHash: `cert-${deviceA}`,
      }],
    });
    await flushMicrotasks();

    expect(helloCount() - previousHelloCount).toBe(2);
    await svcA.recordLocalChanges([{ path: 'config.summary.enabled', value: false }]);
    await flushMicrotasks();

    expect(stateD.config.summary.enabled).toBe(false);
    expect(helloCount() - previousHelloCount).toBe(2);
  });

  it('lets an established peer promote provisional joiners after they exchange member records', async () => {
    const bus = new MockMeshBus();
    const storeA = new MemorySyncStorage();
    let transportA: SyncTransport | undefined;
    const svcA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => {
        transportA = bus.createTransport(cb);
        return transportA;
      },
      applyRemoteConfigPatches: async () => {},
    });
    const created = await svcA.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: '' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rotated = await svcA.handleMessage({ type: 'kiwi:sync:rotate-phrase' });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    await transportA?.stop();

    const storeB = new MemorySyncStorage();
    const storeC = new MemorySyncStorage();
    const svcB = new SyncService({
      storage: storeB,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });
    const svcC = new SyncService({
      storage: storeC,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });
    expect((await svcB.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: rotated.phrase!,
      relayUrl: '',
    })).ok).toBe(true);
    expect((await svcC.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: rotated.phrase!,
      relayUrl: '',
    })).ok).toBe(true);
    await flushMicrotasks();
    expect((await storeB.load())?.settings.epochEstablished).toBe(false);
    expect((await storeC.load())?.settings.epochEstablished).toBe(false);

    const restoredA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });
    await restoredA.init();
    await flushMicrotasks();

    expect(svcB.getStatus().epoch).toBe(2);
    expect(svcC.getStatus().epoch).toBe(2);
    expect((await storeB.load())?.settings.epochEstablished).toBe(true);
    expect((await storeC.load())?.settings.epochEstablished).toBe(true);
  });

  it('defers applying live values until the first covered join batch resolves local preferences', async () => {
    const bus = new MockMeshBus();
    bus.holdCoveredRecords = true;
    const storeA = new MemorySyncStorage();
    const svcA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });
    const created = await svcA.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: '' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const localConfig = structuredClone(DEFAULT_CONFIG);
    localConfig.summary.enabled = false;
    storage.value.config = localConfig;
    const storeD = new MemorySyncStorage();
    const svcD = new SyncService({
      storage: storeD,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        storage.value.config = applySettingsPatch(storage.value.config as typeof DEFAULT_CONFIG, patches);
      },
    });
    const joined = await svcD.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: created.phrase!,
      relayUrl: '',
      conflictMode: 'local',
    });
    expect(joined.ok).toBe(true);
    await flushMicrotasks();
    await vi.waitFor(() => expect(bus.heldCoveredCount).toBeGreaterThan(0));

    await svcA.recordLocalChanges([{ path: 'config.summary.enabled', value: true }]);
    await flushMicrotasks();
    expect((storage.value.config as typeof DEFAULT_CONFIG).summary.enabled).toBe(false);

    bus.releaseCoveredRecords();
    await flushMicrotasks();
    expect((storage.value.config as typeof DEFAULT_CONFIG).summary.enabled).toBe(false);
    expect((await storeD.load())?.settings.pendingInitialJoinSync).toBe(false);
  });

  it('restarts the handshake for unauthenticated peers when sync now is requested', async () => {
    const bus = new MockMeshBus();
    const store = new MemorySyncStorage();
    let onTransportEvent: ((event: TransportEvent) => void) | undefined;
    const service = new SyncService({
      storage: store,
      transportFactory: (cb) => {
        onTransportEvent = cb;
        return bus.createTransport(cb);
      },
      applyRemoteConfigPatches: async () => {},
    });
    const created = await service.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: '' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(onTransportEvent).toBeDefined();
    if (!onTransportEvent) return;

    onTransportEvent({
      type: 'snapshot',
      state: 'connected',
      peers: [{
        peerId: 'offline-peer',
        peerName: 'Offline peer',
        channel: 'webrtc',
        ownCertHash: 'local-cert',
        peerCertHash: 'peer-cert',
      }],
    });
    await flushMicrotasks();
    const helloCount = () =>
      bus.sentMessages.filter(({ payload }) => (JSON.parse(payload) as { type: string }).type === 'hello').length;
    const previousHelloCount = helloCount();

    const syncNow = await service.handleMessage({ type: 'kiwi:sync:sync-now' });

    expect(syncNow.ok).toBe(true);
    expect(helloCount() - previousHelloCount).toBe(1);
  });

  it('syncs config between devices, suppresses echo, keeps keys off by default, and propagates via 3rd device', async () => {
    const bus = new MockMeshBus();
    const stateA = { config: structuredClone(DEFAULT_CONFIG), remoteWrites: 0 };
    const stateB = { config: structuredClone(DEFAULT_CONFIG), remoteWrites: 0 };
    const stateC = { config: structuredClone(DEFAULT_CONFIG), remoteWrites: 0 };

    const storeA = new MemorySyncStorage();
    const storeB = new MemorySyncStorage();
    const storeC = new MemorySyncStorage();

    const svcA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        stateA.remoteWrites++;
        stateA.config = applySettingsPatch(stateA.config, patches);
      },
    });
    const svcB = new SyncService({
      storage: storeB,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        stateB.remoteWrites++;
        stateB.config = applySettingsPatch(stateB.config, patches);
      },
    });
    const svcC = new SyncService({
      storage: storeC,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        stateC.remoteWrites++;
        stateC.config = applySettingsPatch(stateC.config, patches);
      },
    });

    // 1. Device A creates a sync group.
    const createRes = await svcA.handleMessage({
      type: 'kiwi:sync:create-group',
      deviceName: 'Mac Chrome',
      relayUrl: 'wss://relay.local',
    });
    expect(createRes.ok).toBe(true);
    const phrase = createRes.ok ? createRes.phrase : '';
    expect(phrase?.split(/\s+/).length).toBe(24);

    // Persisted storage must never contain the plaintext phrase.
    const rawSavedA = await storeA.load();
    expect(JSON.stringify(rawSavedA)).not.toContain(phrase);

    // 2. Device B joins with the same recovery phrase.
    const joinB = await svcB.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: phrase!,
      deviceName: 'Linux Edge',
      relayUrl: 'wss://relay.local',
      conflictMode: 'group',
    });
    expect(joinB.ok).toBe(true);
    await flushMicrotasks();

    // 3. Device A edits a normal setting AND an API key.
    await svcA.recordLocalChanges([
      { path: 'config.summary.enabled', value: false },
      { path: 'config.judge.blockedDomains#farm.example', value: true },
      { path: 'config.llm.apiKey', value: 'sk-secret-from-a' },
    ]);
    await flushMicrotasks();

    // Device B receives normal setting & domain block, but NOT the API key (keys default OFF).
    expect(stateB.config.summary.enabled).toBe(false);
    expect(stateB.config.judge.blockedDomains).toContain('farm.example');
    expect(stateB.config.llm.apiKey).toBeFalsy();
    // No echo back to A.
    expect(stateA.remoteWrites).toBe(0);

    // 4. Enable `keys` explicitly on both A and B, then update API key on A.
    await svcA.handleMessage({ type: 'kiwi:sync:update-settings', categories: { keys: true } });
    await svcB.handleMessage({ type: 'kiwi:sync:update-settings', categories: { keys: true } });
    await svcA.recordLocalChanges([{ path: 'config.llm.apiKey', value: 'sk-explicit-sync-key' }]);
    await flushMicrotasks();
    expect(stateB.config.llm.apiKey).toBe('sk-explicit-sync-key');

    // 5. Device A goes offline (clears relayUrl), then Device C joins and syncs via B!
    await svcA.handleMessage({ type: 'kiwi:sync:update-settings', relayUrl: '' });
    const joinC = await svcC.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: phrase!,
      deviceName: 'Office Firefox',
      relayUrl: 'wss://relay.local',
      conflictMode: 'group',
    });
    expect(joinC.ok).toBe(true);
    await flushMicrotasks();

    // Device C receives A's settings indirectly via B, and still does NOT receive A's API key (keys OFF on C).
    expect(stateC.config.summary.enabled).toBe(false);
    expect(stateC.config.judge.blockedDomains).toContain('farm.example');
    expect(stateC.config.llm.apiKey).toBeFalsy();

    // 6. Device B removes Device C and rotates the epoch; C's later changes are rejected.
    const statusC = svcC.getStatus();
    expect(statusC.deviceId).toBeTruthy();
    const removeRes = await svcB.handleMessage({
      type: 'kiwi:sync:remove-device',
      deviceId: statusC.deviceId!,
    });
    expect(removeRes.ok).toBe(true);
    expect(removeRes.ok && removeRes.status?.epoch).toBe(2);
    expect(removeRes.ok && removeRes.phrase?.split(/\s+/).length).toBe(24);
  });

  it('promotes relay joiners to the rotated epoch before member-join and bootstraps a snapshot', async () => {
    const bus = new MockMeshBus();
    const storeA = new MemorySyncStorage();
    const storeD = new MemorySyncStorage();
    const stateD = { config: structuredClone(DEFAULT_CONFIG) };
    const svcA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        storage.value.config = applySettingsPatch(storage.value.config as typeof DEFAULT_CONFIG, patches);
      },
    });
    const svcD = new SyncService({
      storage: storeD,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        stateD.config = applySettingsPatch(stateD.config, patches);
      },
    });

    const created = await svcA.handleMessage({
      type: 'kiwi:sync:create-group',
      deviceName: 'Rotated group',
      relayUrl: 'wss://relay.local',
    });
    expect(created.ok).toBe(true);
    await svcA.recordLocalChanges([
      { path: 'config.summary.enabled', value: false },
    ]);
    await svcA.handleMessage({ type: 'kiwi:sync:update-settings', categories: { keys: true } });
    await svcA.recordLocalChanges([{ path: 'config.llm.apiKey', value: 'sk-rotated-snapshot' }]);
    const rotation = await svcA.handleMessage({ type: 'kiwi:sync:rotate-phrase' });
    expect(rotation.ok).toBe(true);
    const rotatedPhrase = rotation.ok ? rotation.phrase : undefined;
    expect(rotatedPhrase).toBeTruthy();
    if (!created.ok || !rotatedPhrase) return;

    const joined = await svcD.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: rotatedPhrase,
      deviceName: 'New relay device',
      relayUrl: 'wss://relay.local',
    });
    expect(joined.ok).toBe(true);
    await flushMicrotasks();

    expect(svcD.getStatus().epoch).toBe(2);
    expect(stateD.config.summary.enabled).toBe(false);
    expect(stateD.config.llm.apiKey).toBeFalsy();
    const storedD = await storeD.load();
    expect(storedD?.engineState.registers['config.llm.apiKey']?.value).toBe('sk-rotated-snapshot');
    expect(storedD?.settings.categories.keys).toBe(false);
  });

  it('promotes a manual-code joiner from the offer epoch before syncing snapshots', async () => {
    const bus = new MockMeshBus();
    const storeA = new MemorySyncStorage();
    const storeD = new MemorySyncStorage();
    const stateD = { config: structuredClone(DEFAULT_CONFIG) };
    const svcA = new SyncService({
      storage: storeA,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async (patches) => {
        storage.value.config = applySettingsPatch(storage.value.config as typeof DEFAULT_CONFIG, patches);
      },
    });
    const svcD = new SyncService({
      storage: storeD,
      transportFactory: (cb) => {
        const transport = bus.createTransport(cb, (config) => config.epoch >= 2);
        return {
          ...transport,
          async createAnswerCode() {
            const record = await storeD.load();
            if (!record) throw new Error('Missing test sync state');
            return encodeConnectionCode(record.groupKeys, {
              kind: 'answer',
              epoch: record.groupKeys.epoch,
              deviceId: record.device.deviceId,
              timestampMs: Date.now(),
              ufrag: 'local',
              pwd: 'local-password',
              fingerprint: 'AA:BB',
              candidates: [],
            });
          },
        };
      },
      applyRemoteConfigPatches: async (patches) => {
        stateD.config = applySettingsPatch(stateD.config, patches);
      },
    });

    await svcA.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: 'wss://relay.local' });
    await svcA.recordLocalChanges([{ path: 'config.summary.enabled', value: false }]);
    const rotation = await svcA.handleMessage({ type: 'kiwi:sync:rotate-phrase' });
    expect(rotation.ok).toBe(true);
    const rotatedPhrase = rotation.ok ? rotation.phrase : undefined;
    expect(rotatedPhrase).toBeTruthy();
    if (!rotatedPhrase) return;

    const joined = await svcD.handleMessage({
      type: 'kiwi:sync:join-group',
      phrase: rotatedPhrase,
      relayUrl: 'wss://relay.local',
    });
    expect(joined.ok).toBe(true);
    const storedA = await storeA.load();
    if (!storedA) throw new Error('Missing test sync state');
    const offerCode = await encodeConnectionCode(storedA.groupKeys, {
      kind: 'offer',
      epoch: storedA.groupKeys.epoch,
      deviceId: storedA.device.deviceId,
      timestampMs: Date.now(),
      ufrag: 'remote',
      pwd: 'remote-password',
      fingerprint: 'CC:DD',
      candidates: [],
    });

    const answer = await svcD.handleMessage({
      type: 'kiwi:sync:create-code',
      kind: 'answer',
      offerCode,
    });
    expect(answer.ok).toBe(true);
    const answerCode = answer.ok ? answer.code : undefined;
    expect(answerCode).toBeTruthy();
    if (!answerCode) return;
    const storedD = await storeD.load();
    if (!storedD) throw new Error('Missing test sync state');
    expect(storedD.groupKeys.epoch).toBe(2);
    expect((await decodeConnectionCode(storedD.groupKeys, answerCode)).epoch).toBe(2);
    await flushMicrotasks();

    expect(stateD.config.summary.enabled).toBe(false);
  });

  it('starts transport with full config when a group has no relay', async () => {
    const store = new MemorySyncStorage();
    const start = vi.fn(async (_config: TransportConfig) => {});
    const transport: SyncTransport = {
      start,
      async stop() {},
      async sendToPeer() {
        return false;
      },
      async broadcast() {},
      async createOfferCode() {
        return 'kiwi1-manual-offer';
      },
      async createAnswerCode() {
        return 'kiwi1-manual-answer';
      },
      async acceptAnswerCode() {},
      attachOffscreenPort() {},
    };
    const service = new SyncService({
      storage: store,
      transportFactory: () => transport,
      applyRemoteConfigPatches: async () => {},
    });

    const created = await service.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: '' });
    expect(created.ok).toBe(true);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ relayUrl: '', deviceId: expect.any(String) }));
    await service.handleMessage({ type: 'kiwi:sync:update-settings', deviceName: 'No Relay Device' });
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ relayUrl: '', deviceName: 'No Relay Device' }));
    const offer = await service.handleMessage({ type: 'kiwi:sync:create-code', kind: 'offer' });
    expect(offer).toMatchObject({ ok: true, code: 'kiwi1-manual-offer' });

    const restoredService = new SyncService({
      storage: store,
      transportFactory: () => transport,
      applyRemoteConfigPatches: async () => {},
    });
    await restoredService.init();
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ relayUrl: '', deviceId: expect.any(String) }));
  });

  it('serializes concurrent local changes through one engine mutation queue', async () => {
    const bus = new MockMeshBus();
    const store = new MemorySyncStorage();
    const service = new SyncService({
      storage: store,
      transportFactory: (cb) => bus.createTransport(cb),
      applyRemoteConfigPatches: async () => {},
    });
    const created = await service.handleMessage({ type: 'kiwi:sync:create-group', relayUrl: '' });
    expect(created.ok).toBe(true);
    const deviceId = service.getStatus().deviceId!;

    await Promise.all([
      service.recordLocalChanges([{ path: 'config.defaultMode', value: 'news' }]),
      service.recordLocalChanges([{ path: 'config.timeoutMs', value: 5000 }]),
    ]);

    const state = (await store.load())?.engineState;
    expect(state?.versionVector[deviceId]).toBe(2);
    expect(state?.recordLog.map((record) => record.seq).sort()).toEqual([1, 2]);
  });
});
