import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { decodeBingUrl, extractJson, reconstructAbstract } from '../src';
import { BROWSER_ENGINES } from '../src/engines';

describe('browser engine extraction fixtures', () => {
  const blockedUrl: Record<string, string> = {
    google: 'https://www.google.com/sorry/',
    bing: 'https://www.bing.com/captcha',
    baidu: 'https://wappass.baidu.com/',
    duckduckgo: 'https://duckduckgo.com/anomaly.js',
    scholar: 'https://scholar.google.com/sorry/',
    youtube: 'https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2Fresults',
    zhihu: 'https://www.zhihu.com/signin?next=%2F',
    x: 'https://x.com/i/jf/onboarding/web',
  };
  for (const [id, engine] of Object.entries(BROWSER_ENGINES)) {
    const fixture = new URL(`./fixtures/${id}.html`, import.meta.url);
    const blockedFixture = new URL(`./fixtures/${id}-blocked.html`, import.meta.url);
    const files = new Set(['google.html', 'bing.html', 'baidu.html', 'duckduckgo.html', 'scholar.html', 'youtube.html', 'bilibili.html', 'zhihu.html', 'rednote.html', 'weixin.html']);
    if (files.has(`${id}.html`)) {
      it(`${id} extracts ranked results from a real browser page`, () => {
        const html = readFileSync(fixture, 'utf8');
        const window = new Window();
        window.document.write(html);
        const hits = engine.extract(window.document as unknown as ParentNode, `https://${id === 'scholar' ? 'scholar.google.com' : id === 'baidu' ? 'www.baidu.com' : `${id}.com`}/`, engine.modes[0]);
        expect(hits.length).toBeGreaterThanOrEqual(8);
        for (const hit of hits) {
          expect(hit.url).toMatch(/^https?:\/\//);
          expect(hit.title.trim().length).toBeGreaterThan(0);
        }
        if (id === 'google') {
          const wrappers = hits.filter((hit) => new URL(hit.url).pathname === '/goto');
          expect(wrappers.length).toBeGreaterThan(0);
          expect(wrappers.some((hit) => hit.host === 'arxiv.org')).toBe(true);
        }
      });
    }
    // Yandex, Bilibili, Xiaohongshu and RedNote have no captured block page, and inventing one would only prove the guess.
    if (!['yandex', 'bilibili', 'xiaohongshu', 'rednote', 'sogou', 'weixin'].includes(id)) {
      it(`${id} recognizes blocked pages when present`, () => {
        try {
          const html = readFileSync(blockedFixture, 'utf8');
          const window = new Window();
          window.document.write(html);
          const isBlockedUrl = engine.isBlockedUrl?.(blockedUrl[id] ?? 'https://yandex.com/showcaptcha');
          expect(isBlockedUrl || engine.isLoginUrl?.(blockedUrl[id] ?? 'https://yandex.com/showcaptcha') || window.document.querySelector(engine.blockedSelector) || (engine.loginSelector && window.document.querySelector(engine.loginSelector))).toBeTruthy();
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error && error.code === 'ENOENT')) throw error;
          expect(engine.isBlockedUrl?.(blockedUrl[id] ?? 'https://yandex.com/showcaptcha') || engine.isLoginUrl?.(blockedUrl[id] ?? 'https://yandex.com/showcaptcha')).toBeTruthy();
        }
      });
    }
  }
});

it('decodes Bing result redirects', () => {
  const target = 'https://example.com/path?x=1';
  const enc = 'a1' + btoa(target).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  expect(decodeBingUrl(`https://www.bing.com/ck/a?!&&p=abc&u=${enc}&ntb=1`, 'https://www.bing.com/search')).toBe(target);
});

describe('helpers', () => {
  it('reconstructs OpenAlex abstracts', () => {
    expect(reconstructAbstract({ fusion: [1], rank: [0], works: [2] })).toBe('rank fusion works');
  });
  it('extracts JSON from fenced LLM output', () => {
    expect(extractJson<{ a: number }>('sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('[{"i":0,"s":9}] trailing')).toEqual([{ i: 0, s: 9 }]);
  });
});
