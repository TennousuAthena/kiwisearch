import { describe, expect, it } from 'vitest';
import type { KiwiHost } from '../host';

/** What a test of a host gives the contract: the host, and a way to change things "elsewhere" (another page, the settings page). */
export interface HostUnderTest {
  host: KiwiHost;
  /** Simulates the stored preferences changing from outside this page. */
  changePreferencesElsewhere(values: Record<string, unknown>): void;
  /** Closes every open stream from the other end (the service worker restarted, the extension was reloaded). */
  hangUpStreamsElsewhere(): void;
  dispose?(): void;
}

/**
 * The behaviour every `KiwiHost` has to share, so the interface runs the same on the extension's own page and on the website. The
 * extension's tests run it against `createExtensionHost`, the website's against `createWebHost` over a real bridge.
 */
export function describeHostContract(name: string, make: () => Promise<HostUnderTest>) {
  describe(`KiwiHost contract: ${name}`, () => {
    it('saves interface preferences and reads them back', async () => {
      const { host, dispose } = await make();
      await host.preferences.save({ 'ui:theme': 'dark' });
      expect(await host.preferences.load()).toMatchObject({ 'ui:theme': 'dark' });
      dispose?.();
    });

    it('tells a subscriber about a change made elsewhere, with only the keys that changed', async () => {
      const { host, changePreferencesElsewhere, dispose } = await make();
      const seen: Array<Record<string, unknown>> = [];
      host.preferences.subscribe((changed) => seen.push(changed));
      changePreferencesElsewhere({ 'ui:summaryMode': 'off' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(seen).toEqual([{ 'ui:summaryMode': 'off' }]);
      dispose?.();
    });

    it('keeps the academic language and treats anything unknown as "no limit"', async () => {
      const { host, dispose } = await make();
      expect(await host.academicLanguage.load()).toBe('any');
      await host.academicLanguage.save('en');
      expect(await host.academicLanguage.load()).toBe('en');
      dispose?.();
    });

    it('blocks a site and takes the block back with the receipt it got', async () => {
      const { host, dispose } = await make();
      const undo = await host.domainPreference('block', 'example.com');
      expect(undo).toMatchObject({ domain: 'example.com', after: { blocked: true } });
      expect(await host.undoDomainPreference(undo)).toBe(true);
      dispose?.();
    });

    it('answers a site icon with an address or null, never an error', async () => {
      const { host, dispose } = await make();
      const icon = await host.favicon('example.com');
      expect(icon === null || typeof icon === 'string').toBe(true);
      dispose?.();
    });

    it('opens a stream that carries a message each way and says when the other end hangs up (the streams of the world under test echo what they are sent)', async () => {
      const { host, hangUpStreamsElsewhere, dispose } = await make();
      const stream = host.connect('search');
      const got: unknown[] = [];
      let closed = false;
      stream.onMessage.addListener((m) => got.push(m));
      stream.onDisconnect.addListener(() => { closed = true; });
      stream.postMessage({ type: 'keepalive' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(got).toEqual([{ type: 'keepalive' }]);
      hangUpStreamsElsewhere();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(closed).toBe(true);
      dispose?.();
    });

    it('writes addresses in one of the two styles the interface reads', async () => {
      const { host, dispose } = await make();
      expect(['search', 'hash']).toContain(host.urlStyle);
      expect(host.homeUrl).toMatch(/^[a-z-]+:\/\//);
      dispose?.();
    });
  });
}
