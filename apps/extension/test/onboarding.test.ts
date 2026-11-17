import { DEFAULT_CONFIG, type SourceId } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { classifyResponse, planFromProbe, PROBE_URLS, probeSources, WEB_ALTERNATIVES, type ProbeResult } from '../lib/reachability';
import { t } from '@kiwi-search/app/i18n';
import { GROUPS, SOURCE_INFO, sourcesInGroup } from '../lib/sourceCatalog';
import { confirmSteps } from '../lib/sourceConfirm';

const ok: ProbeResult = { reach: 'ok', ms: 10 };
const down: ProbeResult = { reach: 'unreachable', ms: 5000 };
const all = (reach: ProbeResult) => Object.fromEntries((Object.keys(PROBE_URLS) as SourceId[]).filter((id) => PROBE_URLS[id]).map((id) => [id, reach])) as Record<SourceId, ProbeResult>;

describe('what the network check asks', () => {
  it('has a fixed https address on the source\'s own host for every source but the user\'s own server', () => {
    for (const id of Object.keys(SOURCE_INFO) as SourceId[]) {
      if (id === 'searxng') { expect(PROBE_URLS[id]).toBeNull(); continue; }
      expect(PROBE_URLS[id], id).toMatch(/^https:\/\/[a-z0-9.-]+\//);
    }
  });

  it('reads any answer as reachable, and a refusal or a region block as limited', () => {
    expect(classifyResponse(204)).toBe('ok');
    expect(classifyResponse(404)).toBe('ok');
    expect(classifyResponse(302)).toBe('ok');
    for (const status of [403, 429, 451]) expect(classifyResponse(status)).toBe('limited');
  });

  it('asks without cookies, times out a site that does not answer, and reports each result as it comes in', async () => {
    const inits: RequestInit[] = [];
    const fetch = (url: string, init: RequestInit) => {
      inits.push(init);
      if (url.includes('google')) return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      if (url.includes('bing')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response('', { status: 200 }));
    };
    const seen: string[] = [];
    const results = await probeSources(fetch, ['google', 'bing', 'duckduckgo', 'searxng'], { timeoutMs: 30, onResult: (id) => seen.push(id) });
    expect(results.google?.reach).toBe('unreachable');
    expect(results.bing?.reach).toBe('unreachable');
    expect(results.duckduckgo?.reach).toBe('ok');
    expect(results.searxng).toBeUndefined();
    expect(seen.sort()).toEqual(['bing', 'duckduckgo', 'google']);
    expect(inits.every((init) => init.credentials === 'omit' && init.cache === 'no-store' && init.redirect === 'manual')).toBe(true);
  });

  it('reports nothing once the page stops the check', async () => {
    const stop = new AbortController();
    const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const running = probeSources(fetch, ['google', 'bing'], { timeoutMs: 1000, signal: stop.signal });
    stop.abort();
    expect(await running).toEqual({});
  });
});

describe('what the network check changes', () => {
  it('changes nothing when every site answers', () => {
    expect(planFromProbe(DEFAULT_CONFIG, all(ok))).toMatchObject({ turnOff: [], suggest: [] });
  });

  it('switches off the sources that are on and cannot be reached, and never switches one on', () => {
    // Roughly what a network without access to Google, Brave, DuckDuckGo, YouTube and X looks like.
    const blocked: SourceId[] = ['google', 'bravesearch', 'duckduckgo', 'scholar', 'youtube', 'x', 'brave', 'exa'];
    const results = { ...all(ok), ...Object.fromEntries(blocked.map((id) => [id, down])) };
    const plan = planFromProbe(DEFAULT_CONFIG, results);
    expect(plan.turnOff.sort()).toEqual(blocked.filter((id) => DEFAULT_CONFIG.sources[id]?.enabled).sort());
    expect(plan.webLeft).toEqual(['bing']);
    // Bing alone is too few: the reachable alternatives that are off are offered, not switched on.
    expect(plan.suggest).toEqual(WEB_ALTERNATIVES);
    expect(plan.turnOff).not.toContain('sogou');
  });

  it('never offers or switches on Baidu, whatever the network', () => {
    const results = { ...all(down), baidu: ok, sogou: ok };
    const plan = planFromProbe(DEFAULT_CONFIG, results);
    expect(plan.suggest).not.toContain('baidu');
    expect(plan.turnOff).not.toContain('baidu');
    expect(WEB_ALTERNATIVES).not.toContain('baidu');
    expect(plan.suggest).toEqual(['sogou']);
  });

  it('leaves alone a source the user switched by hand', () => {
    const plan = planFromProbe(DEFAULT_CONFIG, { ...all(ok), google: down }, new Set<SourceId>(['google']));
    expect(plan.turnOff).not.toContain('google');
  });
});

describe('switching a source on that needs a yes', () => {
  it('asks once for Kagi and not at all for an ordinary source', () => {
    expect(confirmSteps('kagi')).toHaveLength(1);
    expect(confirmSteps('google')).toEqual([]);
  });

  it('asks three times for Baidu, more firmly each time, with "keep it off" highlighted at the end', () => {
    const steps = confirmSteps('baidu');
    expect(steps.map((step) => step.body)).toEqual(['source.confirm.baidu', 'source.confirm.baidu2', 'source.confirm.baidu3']);
    expect(steps.at(-1)).toMatchObject({ primary: 'cancel', cancel: 'source.confirmCancel.baidu3', confirm: 'source.confirmAction.baidu3' });
    // The later steps hold their confirm button, so a run of clicks cannot answer all three.
    expect(steps.slice(1).every((step) => (step.holdMs ?? 0) >= 500)).toBe(true);
  });

  it('puts the confirm button in a different place at each of Baidu\'s questions, so one click repeated cannot answer them all', () => {
    const layouts = confirmSteps('baidu').map((step) => step.layout);
    expect(layouts).toEqual(['end', 'start', 'stack']);
    expect(new Set(layouts).size).toBe(layouts.length);
    // A question asked once has no neighbour to differ from.
    expect(confirmSteps('kagi')[0].layout).toBeUndefined();
  });

  it('never says how many questions there are, or which one this is', () => {
    const texts = confirmSteps('baidu').flatMap((step) => [step.body, step.title, step.confirm, step.cancel].filter((key): key is NonNullable<typeof key> => !!key).map((key) => t(key)));
    expect(texts.length).toBeGreaterThanOrEqual(6);
    for (const text of texts) expect(text, text).not.toMatch(/[一二三四五六七八九十\d]\s*次|第\s*[一二三四五六七八九十\d]|最后|共\s*[一二三四五六七八九十\d]/);
  });

  it('keeps Baidu off by default', () => {
    expect(DEFAULT_CONFIG.sources.baidu?.enabled).toBe(false);
  });
});

describe('the order of the sources on the settings page', () => {
  it('lists the groups in the order of the tabs on the results page', () => {
    expect(GROUPS.map((group) => group.id)).toEqual(['web', 'image', 'video', 'shopping', 'academic', 'community']);
  });

  it('keeps the two Brave sources side by side: they are one index, and turning on both counts it twice', () => {
    const web = sourcesInGroup('web');
    expect(Math.abs(web.indexOf('bravesearch') - web.indexOf('brave'))).toBe(1);
  });

  it('puts what works out of the box before what needs an account, a key or a server', () => {
    const web = sourcesInGroup('web');
    const needs = (id: SourceId) => !!SOURCE_INFO[id].key || !!SOURCE_INFO[id].baseUrl || !!SOURCE_INFO[id].loginUrl;
    // The Brave API needs a key too, but it stays beside its twin (the test above).
    const keyed = web.filter((id) => needs(id) && id !== 'brave');
    for (const id of keyed) for (const free of web.filter((other) => !needs(other))) expect(web.indexOf(free), `${free} before ${id}`).toBeLessThan(web.indexOf(id));
    // The self-hosted one is last.
    expect(web.at(-1)).toBe('searxng');
  });
});
