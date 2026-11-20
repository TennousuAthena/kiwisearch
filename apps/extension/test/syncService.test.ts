import { DEFAULT_CONFIG } from '@kiwi-search/core';
import { storageKey } from '@kiwi-search/protocol';
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

  createTransport(onEvent: (ev: TransportEvent) => void): SyncTransport {
    let myId = '';
    const bus = this;
    return {
      async start(config: TransportConfig) {
        myId = config.deviceId;
        bus.nodes.set(myId, { onEvent, connected: new Set() });
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
        const peer = bus.nodes.get(peerId);
        if (!peer || !peer.connected.has(myId)) return false;
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
});

describe('SyncService multi-device integration', () => {
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
});
