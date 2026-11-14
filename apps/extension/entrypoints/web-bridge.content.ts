import { createBridgeRelay, PROTOCOL_VERSION, type HelloReply, type Relay, type StreamName } from '@kiwi-search/protocol';
import { browser } from 'wxt/browser';
import { createBridgeLifecycle } from '@/lib/bridgeLifecycle';
import type { WebReply } from '@/lib/webBridge';
import { isWebSitePage, WEB_MATCHES } from '@/lib/webOrigins';

/**
 * The page's way to the extension. It runs only on the search page of the Kiwi website, in the top frame, and does three things: it marks the page so the
 * page knows at its first script that the extension is here, it takes the private `MessagePort` the page hands over, and it relays what
 * comes through that port to the service worker, which checks all of it again. The port is private: nothing is broadcast on `window`.
 */
export default defineContentScript({
  matches: WEB_MATCHES,
  runAt: 'document_start',
  main() {
    // A match pattern has no port and ignores the query; the origin and the path are checked exactly.
    if (!isWebSitePage(new URL(location.href))) return;
    document.documentElement.dataset.kiwi = String(PROTOCOL_VERSION);

    let relay: Relay | null = null;
    let pushPort: ReturnType<typeof browser.runtime.connect> | null = null;
    let pushRetries = 0;

    const ask = async (message: object): Promise<WebReply> => (await browser.runtime.sendMessage(message)) as WebReply;

    /** Preference changes made elsewhere reach the page through a port the service worker pushes to. */
    const connectPush = () => {
      if (!relay || pushPort) return;
      const port = browser.runtime.connect({ name: 'web-push' });
      pushPort = port;
      port.onMessage.addListener((message) => {
        const { name, data } = (message ?? {}) as { name?: unknown; data?: unknown };
        if (typeof name === 'string') relay?.push(name, data);
      });
      port.onDisconnect.addListener(() => {
        pushPort = null;
        // The service worker restarts now and then; a few quiet retries bring the port back.
        if (relay && pushRetries++ < 5) setTimeout(connectPush, 1000);
      });
    };

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { kiwi?: unknown } | null;
      if (!data || data.kiwi !== 'connect' || event.ports.length !== 1) return;
      // A page that connects again replaces its earlier link.
      relay?.close();
      pushPort?.disconnect();
      pushPort = null;
      pushRetries = 0;
      relay = createBridgeRelay(event.ports[0], {
        hello: async (): Promise<HelloReply> => {
          const reply = await ask({ type: 'kiwi-web:hello' });
          if (!reply?.ok) throw new Error('refused');
          const hello = reply.result as HelloReply;
          if (hello.state === 'ok') connectPush();
          return hello;
        },
        request: async (method, params) => {
          const reply = await ask({ type: 'kiwi-web:request', method, params });
          if (!reply?.ok) throw reply?.error ?? { code: 'failed', message: 'No answer from the extension' };
          return reply.result;
        },
        openStream: (name: StreamName) => browser.runtime.connect({ name }),
      });
    });

    const lifecycle = createBridgeLifecycle({
      closeAll: () => { relay?.close(); pushPort?.disconnect(); },
      restorePush: () => { pushRetries = 0; pushPort?.disconnect(); pushPort = null; connectPush(); },
    });
    window.addEventListener('pagehide', (event) => lifecycle.pagehide(event.persisted));
    window.addEventListener('pageshow', (event) => lifecycle.pageshow(event.persisted));
  },
});
