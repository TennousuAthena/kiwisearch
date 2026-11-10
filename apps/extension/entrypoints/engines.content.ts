import type { SearchHit } from '@fusion-search/core';
import { browser } from 'wxt/browser';
import { BROWSER_ENGINES } from '@fusion-search/core';

const matches = [...new Set(Object.values(BROWSER_ENGINES).flatMap((engine) => engine.matches))];

export default defineContentScript({
  matches,
  allFrames: false,
  runAt: 'document_idle',
  async main() {
    const handshake = (await browser.runtime.sendMessage({ type: 'fusion:worker?' })) as
      | { type: 'fusion:worker!'; engine: string; requestId: string }
      | { type: 'fusion:not-worker' }
      | undefined;
    if (!handshake || handshake.type !== 'fusion:worker!') return;
    const { engine: engineId, requestId } = handshake;
    const engine = BROWSER_ENGINES[engineId as keyof typeof BROWSER_ENGINES];
    if (!engine) return;

    let blockedSent = false;
    let finished = false;
    let timeout: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(check);
    const finish = (hits: Omit<SearchHit, 'source'>[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      observer.disconnect();
        void browser.runtime.sendMessage({ type: 'fusion:extracted', requestId, hits });
    };
    function check() {
      if (finished) return;
      const blocked = engine.isBlockedUrl?.(location.href) || !!document.querySelector(engine.blockedSelector);
      if (blocked && !blockedSent) {
        blockedSent = true;
        clearTimeout(timeout);
        void browser.runtime.sendMessage({ type: 'fusion:blocked', requestId });
        timeout = setTimeout(() => {
          finished = true;
          observer.disconnect();
        }, 120000);
        return;
      }
      if (blockedSent) return;
      const hits = engine.extract(document, location.href);
      if (hits.length) {
        finish(hits);
      }
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    timeout = setTimeout(() => {
      if (blockedSent) {
        finished = true;
        observer.disconnect();
      } else {
        finish([]);
      }
    }, 12000);
    check();
  },
});
