import { describe, expect, it } from 'vitest';
import { isSiteUnreachable, searchFromFailedNavigation } from '../lib/siteFallback';
import { parseUiSource } from '../lib/uiSource';

const SITE = 'https://kiwi.moe';
const failed = (url: string, error = 'net::ERR_NAME_NOT_RESOLVED', extra = {}) => ({ url, error, frameId: 0, tabId: 4, ...extra });

describe('which errors mean the website cannot be reached', () => {
  it('counts name, connection and secure-connection failures, in Chromium and Firefox wording', () => {
    for (const error of ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_TIMED_OUT', 'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_CERT_DATE_INVALID', 'NS_ERROR_UNKNOWN_HOST', 'NS_ERROR_NET_TIMEOUT']) {
      expect(isSiteUnreachable(error), error).toBe(true);
    }
  });

  it('does not count the user cancelling, a blocked request or an unrelated error', () => {
    for (const error of ['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_FILE_NOT_FOUND', '', undefined]) expect(isSiteUnreachable(error), String(error)).toBe(false);
  });
});

describe('what is done with a failed navigation', () => {
  it('reads the search from the address it failed on, in either form', () => {
    expect(searchFromFailedNavigation(failed(`${SITE}/#q=hello%20world`), SITE)).toEqual({ query: 'hello world', mode: 'web' });
    expect(searchFromFailedNavigation(failed(`${SITE}/#m=news&q=a&b=c`), SITE)).toEqual({ query: 'a&b=c', mode: 'news' });
    expect(searchFromFailedNavigation(failed(`${SITE}/`), SITE)).toEqual({ query: '', mode: 'web' });
  });

  it('leaves alone anything that is not the website\'s own top-level navigation failing', () => {
    expect(searchFromFailedNavigation(failed('https://example.com/#q=x'), SITE)).toBeNull();
    expect(searchFromFailedNavigation(failed(`${SITE}/#q=x`, 'net::ERR_ABORTED'), SITE)).toBeNull();
    expect(searchFromFailedNavigation(failed(`${SITE}/#q=x`, 'net::ERR_NAME_NOT_RESOLVED', { frameId: 2 }), SITE)).toBeNull();
    expect(searchFromFailedNavigation(failed(`${SITE}/#q=x`, 'net::ERR_NAME_NOT_RESOLVED', { tabId: -1 }), SITE)).toBeNull();
    expect(searchFromFailedNavigation(failed('not a url'), SITE)).toBeNull();
    // Only the search page: a failed introduction or install page has no search to carry over.
    expect(searchFromFailedNavigation(failed(`${SITE}/install`), SITE)).toBeNull();
    expect(searchFromFailedNavigation(failed('https://s.kiwi.moe/#q=x'), SITE)).toBeNull();
  });
});

describe('the setting', () => {
  it('is the website unless it says local', () => {
    expect(parseUiSource('local')).toBe('local');
    for (const value of ['site', 'LOCAL', undefined, null, 1, {}]) expect(parseUiSource(value)).toBe('site');
  });
});
