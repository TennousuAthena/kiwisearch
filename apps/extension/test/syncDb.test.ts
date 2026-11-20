import { importGroupSecret } from '@kiwi-search/sync';
import { describe, expect, it } from 'vitest';
import { MemorySyncStorage, type StoredSyncRecord } from '../lib/syncDb';

describe('Sync storage', () => {
  it('prunes expired previous secrets and keeps only the three newest on load', async () => {
    const secret = await importGroupSecret(new Uint8Array(32));
    const now = Date.now();
    const entries = [
      ...Array.from({ length: 5 }, (_, index) => ({
        epoch: index + 1,
        secret,
        rotatedAt: now - index * 1_000,
      })),
      { epoch: 6, secret, rotatedAt: now - 31 * 24 * 60 * 60 * 1_000 },
    ];
    const storage = new MemorySyncStorage();
    (storage as unknown as { value: StoredSyncRecord | null }).value = {
      previousGroupSecrets: entries,
    } as StoredSyncRecord;

    const stored = await storage.load();

    expect(stored?.previousGroupSecrets.map((entry) => entry.epoch)).toEqual([1, 2, 3]);
    expect(stored?.previousGroupSecrets[0]?.secret.extractable).toBe(false);
    expect(stored?.previousGroupSecrets[0]?.secret.algorithm.name).toBe('HKDF');
  });
});
