import type { SearchHit, SourceId } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { BROWSER_ENGINES } from '@kiwi-search/core';

const matches = [...new Set(Object.values(BROWSER_ENGINES).flatMap((engine) => engine.matches))];

export default defineContentScript({
  matches,
  allFrames: false,
  runAt: 'document_idle',
  async main() {
    const handshake = (await browser.runtime.sendMessage({ type: 'kiwi:worker?' })) as
      | { type: 'kiwi:worker!'; engine: SourceId; requestId: string }
      | { type: 'kiwi:not-worker' }
      | undefined;
    if (!handshake || handshake.type !== 'kiwi:worker!') return;
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
        void browser.runtime.sendMessage({ type: 'kiwi:extracted', requestId, hits });
    };
    function check() {
      if (finished) return;
      const blocked = engine.isBlockedUrl?.(location.href) || !!document.querySelector(engine.blockedSelector);
      if (blocked && !blockedSent) {
        blockedSent = true;
        clearTimeout(timeout);
        void browser.runtime.sendMessage({ type: 'kiwi:blocked', requestId });
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
