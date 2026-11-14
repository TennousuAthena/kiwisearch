import { describeHostContract } from '@kiwi-search/app/testing';
import { beforeEach, vi } from 'vitest';

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
const world = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  listeners: [] as Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>,
  ports: [] as Array<{ hangUp(): void }>,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in world.store).map((k) => [k, world.store[k]])),
        set: async (values: Record<string, unknown>) => { Object.assign(world.store, values); },
      },
      onChanged: { addListener: (l: Listener) => { world.listeners.push(l); } },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://abc${path}`,
      sendMessage: async (message: { type: string; host?: string; domain?: string; action?: string; undo?: unknown }) => {
        if (message.type === 'kiwi:favicon') return { src: null };
        if (message.type === 'kiwi:update-settings') {
          if (message.undo) return { ok: true, restored: true };
          return { ok: true, undo: { domain: message.domain, before: { blocked: false, boosted: false }, after: { blocked: message.action === 'block', boosted: false }, revision: 'r1' } };
        }
        return undefined;
      },
      connect: () => {
        const onMessage: Array<(m: unknown) => void> = []; const onDisconnect: Array<() => void> = [];
        const port = {
          postMessage: (m: unknown) => queueMicrotask(() => onMessage.forEach((l) => l(m))),
          disconnect: () => {},
          onMessage: { addListener: (l: (m: unknown) => void) => { onMessage.push(l); } },
          onDisconnect: { addListener: (l: () => void) => { onDisconnect.push(l); } },
          hangUp: () => onDisconnect.forEach((l) => l()),
        };
        world.ports.push(port);
        return port;
      },
    },
  },
}));

beforeEach(() => { world.store = {}; world.listeners = []; world.ports = []; });

describeHostContract('extension page', async () => {
  const { createExtensionHost } = await import('../lib/extensionHost');
  const host = createExtensionHost();
  return {
    host,
    changePreferencesElsewhere: (values) => world.listeners.forEach((l) => l(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'local')),
    hangUpStreamsElsewhere: () => world.ports.forEach((p) => p.hangUp()),
  };
});
