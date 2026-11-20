export type SyncCategoryKey = 'search' | 'filters' | 'ui' | 'keys';

export interface SyncCategoryPrefs {
  search: boolean;
  filters: boolean;
  ui: boolean;
  keys: boolean;
}

export type SyncTransportState = 'idle' | 'connecting' | 'connected' | 'offline' | 'error';

export type SyncPeerChannel = 'webrtc' | 'relay' | 'none';

export type SyncJoinConflictMode = 'group' | 'local' | 'merge';

export interface SyncPeerStatus {
  deviceId: string;
  deviceName: string;
  status: 'online' | 'offline' | 'removed';
  channel: SyncPeerChannel;
  lastSeenAt?: number;
  certFingerprint?: string;
}

export interface SyncStatusSnapshot {
  enabled: boolean;
  deviceId: string | null;
  deviceName: string;
  epoch: number;
  relayUrl: string;
  stunEnabled: boolean;
  stunUrls: string[];
  categories: SyncCategoryPrefs;
  transportState: SyncTransportState;
  transportError?: string;
  peers: SyncPeerStatus[];
  lastSyncAt?: number;
  recordCount: number;
  joinConflictMode: SyncJoinConflictMode;
}

export type SyncRuntimeMessage =
  | { type: 'kiwi:sync:status' }
  | {
      type: 'kiwi:sync:create-group';
      deviceName?: string;
      relayUrl?: string;
      stunEnabled?: boolean;
      stunUrls?: string[];
    }
  | {
      type: 'kiwi:sync:join-group';
      phrase: string;
      deviceName?: string;
      relayUrl?: string;
      stunEnabled?: boolean;
      stunUrls?: string[];
      conflictMode?: SyncJoinConflictMode;
    }
  | { type: 'kiwi:sync:leave-group' }
  | {
      type: 'kiwi:sync:update-settings';
      deviceName?: string;
      relayUrl?: string;
      stunEnabled?: boolean;
      stunUrls?: string[];
      categories?: Partial<SyncCategoryPrefs>;
    }
  | { type: 'kiwi:sync:sync-now' }
  | { type: 'kiwi:sync:remove-device'; deviceId: string }
  | { type: 'kiwi:sync:rotate-phrase' }
  | { type: 'kiwi:sync:create-code'; kind: 'offer' | 'answer'; offerCode?: string }
  | { type: 'kiwi:sync:accept-code'; code: string };

export type SyncRuntimeResponse =
  | { ok: true; status: SyncStatusSnapshot; phrase?: string; code?: string }
  | { ok: false; error: string };

export function isSyncRuntimeMessage(message: unknown): message is SyncRuntimeMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    typeof (message as { type?: unknown }).type === 'string' &&
    (message as { type: string }).type.startsWith('kiwi:sync:')
  );
}
