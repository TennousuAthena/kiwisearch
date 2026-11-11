import type { SearchHit, SearchMode, SourceId } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { BROWSER_ENGINES } from '@kiwi-search/core';

const matches = [...new Set(Object.values(BROWSER_ENGINES).flatMap((engine) => engine.matches))];

/** Coalesce bursts of DOM changes into one check. */
const CHECK_DEBOUNCE_MS = 120;
/** With fewer results than asked for, wait this long after the last DOM change before taking what is there. */
const SETTLE_MS = 600;
const PAGE_TIMEOUT_MS = 12000;
const BLOCKED_TIMEOUT_MS = 120000;

type Handshake =
  | { type: 'kiwi:worker!'; engine: SourceId; requestId: string; count: number; mode: SearchMode }
  | { type: 'kiwi:not-worker' }
  | undefined;

export default defineContentScript({
  matches,
  allFrames: false,
  runAt: 'document_idle',
  async main() {
    const handshake = (await browser.runtime.sendMessage({ type: 'kiwi:worker?' })) as Handshake;
    if (!handshake || handshake.type !== 'kiwi:worker!') return;
    const { engine: engineId, requestId, count, mode } = handshake;
    const engine = BROWSER_ENGINES[engineId as keyof typeof BROWSER_ENGINES];
    if (!engine) return;

    let blockedSent = false;
    let finished = false;
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let pageTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(scheduleCheck);
    const extract = () => engine.extract(document, location.href, mode);
    const stop = () => {
      finished = true;
      clearTimeout(checkTimer);
      clearTimeout(settleTimer);
      clearTimeout(pageTimer);
      observer.disconnect();
    };
    const finish = (hits: Omit<SearchHit, 'source'>[]) => {
      if (finished) return;
      stop();
      void browser.runtime.sendMessage({ type: 'kiwi:extracted', requestId, hits });
    };

    function scheduleCheck() {
      if (finished || checkTimer !== undefined) return;
      checkTimer = setTimeout(() => {
        checkTimer = undefined;
        check();
      }, CHECK_DEBOUNCE_MS);
    }

    function check() {
      if (finished || blockedSent) return;
      // A login wall is told apart from a captcha: the page then says "sign in" instead of "verify".
      const login = !!engine.isLoginUrl?.(location.href) || (!!engine.loginSelector && !!document.querySelector(engine.loginSelector));
      if (login || engine.isBlockedUrl?.(location.href) || document.querySelector(engine.blockedSelector)) {
        blockedSent = true;
        clearTimeout(settleTimer);
        clearTimeout(pageTimer);
        void browser.runtime.sendMessage({ type: 'kiwi:blocked', requestId, reason: login ? 'login' : 'captcha' });
        // After the user solves it the engine navigates and this script is injected afresh.
        pageTimer = setTimeout(stop, BLOCKED_TIMEOUT_MS);
        return;
      }
      // The ready selector is a cheap test; only run the full extraction once results are rendering.
      if (!document.querySelector(engine.readySelector)) return;
      const hits = extract();
      if (!hits.length) return;
      if (hits.length >= count) {
        finish(hits);
        return;
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(extract()), SETTLE_MS);
    }

    observer.observe(document.documentElement, { childList: true, subtree: true });
    pageTimer = setTimeout(() => {
      if (blockedSent) stop();
      else finish(extract());
    }, PAGE_TIMEOUT_MS);
    check();
  },
});
