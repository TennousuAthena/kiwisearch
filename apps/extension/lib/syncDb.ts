import type { DeviceKeys, GroupKeys, PersistedSyncEngineState, SyncCategorySettings } from '@kiwi-search/sync';
import type { SyncJoinConflictMode } from '@kiwi-search/protocol';

export const SYNC_DB_NAME = 'kiwi-sync';
export const SYNC_DB_VERSION = 1;
export const PREVIOUS_GROUP_SECRET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_PREVIOUS_GROUP_SECRETS = 3;

export interface PreviousGroupSecret {
  epoch: number;
  secret: CryptoKey;
  rotatedAt: number;
}

export function prunePreviousGroupSecrets(
  entries: readonly PreviousGroupSecret[] | undefined,
  nowMs = Date.now(),
): PreviousGroupSecret[] {
  const cutoff = nowMs - PREVIOUS_GROUP_SECRET_MAX_AGE_MS;
  return (entries ?? [])
    .filter(
      (entry) =>
        Number.isInteger(entry.epoch) &&
        entry.epoch > 0 &&
        Number.isFinite(entry.rotatedAt) &&
        entry.rotatedAt >= cutoff &&
        entry.rotatedAt <= nowMs,
    )
    .sort((a, b) => b.rotatedAt - a.rotatedAt)
    .slice(0, MAX_PREVIOUS_GROUP_SECRETS);
}

export interface SyncLocalSettings {
  deviceName: string;
  relayUrl: string;
  stunEnabled: boolean;
  stunUrls: string[];
  categories: SyncCategorySettings;
  joinConflictMode: SyncJoinConflictMode;
  epochEstablished?: boolean;
  pendingInitialJoinSync?: boolean;
}

export interface StoredSyncRecord {
  device: DeviceKeys;
  groupSecret: CryptoKey;
  groupKeys: GroupKeys;
  epochKeys: Record<number, CryptoKey>;
  previousGroupSecrets: PreviousGroupSecret[];
  certificate?: RTCCertificate;
  settings: SyncLocalSettings;
  engineState: PersistedSyncEngineState;
}

export interface SyncStorageAdapter {
  load(): Promise<StoredSyncRecord | null>;
  save(record: StoredSyncRecord): Promise<void>;
  clear(): Promise<void>;
}

const STORE_KEY = 'singleton';

function openSyncIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open kiwi-sync IndexedDB'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqValue<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

interface StoredKeyMaterial {
  device: DeviceKeys;
  groupSecret: CryptoKey;
  groupKeys: GroupKeys;
  epochKeys: Record<number, CryptoKey>;
  previousGroupSecrets?: PreviousGroupSecret[];
  certificate?: RTCCertificate;
}

interface StoredStateMaterial {
  settings: SyncLocalSettings;
  engineState: PersistedSyncEngineState;
}

/**
 * Persistent storage backed by IndexedDB (`kiwi-sync`).
 * Stores derived non-extractable CryptoKeys and WebRTC RTCCertificates in the `keys` store
 * and sync metadata/records/version vectors in the `state` store.
 * Plaintext recovery phrases are never stored.
 */
export class IndexedDbSyncStorage implements SyncStorageAdapter {
  async load(): Promise<StoredSyncRecord | null> {
    const db = await openSyncIdb();
    let record: StoredSyncRecord | null = null;
    let needsPruning = false;
    try {
      const tx = db.transaction(['keys', 'state'], 'readonly');
      const [keys, state] = await Promise.all([
        reqValue(tx.objectStore('keys').get(STORE_KEY) as IDBRequest<StoredKeyMaterial | undefined>),
        reqValue(tx.objectStore('state').get(STORE_KEY) as IDBRequest<StoredStateMaterial | undefined>),
      ]);
      await txDone(tx);
      if (!keys || !state) return null;
      const previousGroupSecrets = prunePreviousGroupSecrets(keys.previousGroupSecrets);
      needsPruning = previousGroupSecrets.length !== (keys.previousGroupSecrets ?? []).length;
      record = {
        device: keys.device,
        groupSecret: keys.groupSecret,
        groupKeys: keys.groupKeys,
        epochKeys: keys.epochKeys ?? {},
        previousGroupSecrets,
        certificate: keys.certificate,
        settings: state.settings,
        engineState: state.engineState,
      };
    } finally {
      db.close();
    }
    if (record && needsPruning) await this.save(record);
    return record;
  }

  async save(record: StoredSyncRecord): Promise<void> {
    const db = await openSyncIdb();
    try {
      const tx = db.transaction(['keys', 'state'], 'readwrite');
      const keysMaterial: StoredKeyMaterial = {
        device: record.device,
        groupSecret: record.groupSecret,
        groupKeys: record.groupKeys,
        epochKeys: record.epochKeys,
        previousGroupSecrets: prunePreviousGroupSecrets(record.previousGroupSecrets),
        certificate: record.certificate,
      };
      const stateMaterial: StoredStateMaterial = {
        settings: record.settings,
        engineState: record.engineState,
      };
      tx.objectStore('keys').put(keysMaterial, STORE_KEY);
      tx.objectStore('state').put(stateMaterial, STORE_KEY);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async clear(): Promise<void> {
    const db = await openSyncIdb();
    try {
      const tx = db.transaction(['keys', 'state'], 'readwrite');
      tx.objectStore('keys').delete(STORE_KEY);
      tx.objectStore('state').delete(STORE_KEY);
      await txDone(tx);
    } finally {
      db.close();
    }
  }
}

/** In-memory adapter for unit tests where IndexedDB is unavailable. */
export class MemorySyncStorage implements SyncStorageAdapter {
  private value: StoredSyncRecord | null = null;

  async load(): Promise<StoredSyncRecord | null> {
    if (this.value) this.value.previousGroupSecrets = prunePreviousGroupSecrets(this.value.previousGroupSecrets);
    return this.value;
  }

  async save(record: StoredSyncRecord): Promise<void> {
    this.value = {
      ...record,
      previousGroupSecrets: prunePreviousGroupSecrets(record.previousGroupSecrets),
    };
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

export function createDefaultSyncStorage(): SyncStorageAdapter {
  return typeof indexedDB !== 'undefined' ? new IndexedDbSyncStorage() : new MemorySyncStorage();
}
