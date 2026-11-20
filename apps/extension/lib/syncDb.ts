import type { DeviceKeys, GroupKeys, PersistedSyncEngineState, SyncCategorySettings } from '@kiwi-search/sync';
import type { SyncJoinConflictMode } from '@kiwi-search/protocol';

export const SYNC_DB_NAME = 'kiwi-sync';
export const SYNC_DB_VERSION = 1;

export interface SyncLocalSettings {
  deviceName: string;
  relayUrl: string;
  stunEnabled: boolean;
  stunUrls: string[];
  categories: SyncCategorySettings;
  joinConflictMode: SyncJoinConflictMode;
}

export interface StoredSyncRecord {
  device: DeviceKeys;
  groupSecret: CryptoKey;
  groupKeys: GroupKeys;
  epochKeys: Record<number, CryptoKey>;
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
    try {
      const tx = db.transaction(['keys', 'state'], 'readonly');
      const [keys, state] = await Promise.all([
        reqValue(tx.objectStore('keys').get(STORE_KEY) as IDBRequest<StoredKeyMaterial | undefined>),
        reqValue(tx.objectStore('state').get(STORE_KEY) as IDBRequest<StoredStateMaterial | undefined>),
      ]);
      await txDone(tx);
      if (!keys || !state) return null;
      return {
        device: keys.device,
        groupSecret: keys.groupSecret,
        groupKeys: keys.groupKeys,
        epochKeys: keys.epochKeys ?? {},
        certificate: keys.certificate,
        settings: state.settings,
        engineState: state.engineState,
      };
    } finally {
      db.close();
    }
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
    return this.value;
  }

  async save(record: StoredSyncRecord): Promise<void> {
    this.value = record;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

export function createDefaultSyncStorage(): SyncStorageAdapter {
  return typeof indexedDB !== 'undefined' ? new IndexedDbSyncStorage() : new MemorySyncStorage();
}
