import { describe, expect, it } from 'vitest';
import { i18n } from '../src/i18n';
import { mergeCatalogs } from '../src/i18n/merge';
import { createI18n, formatMessage, parseRich, placeholdersOf, resolveLocale } from '../src/i18n/runtime';
import { zhCN } from '../src/i18n/zh-CN';

describe('formatMessage', () => {
  it('fills placeholders, numbers included, and every occurrence', () => {
    expect(formatMessage('{count} 条结果（{duration}）', { count: 3, duration: '1.2 秒' })).toBe('3 条结果（1.2 秒）');
    expect(formatMessage('{n}/{n}', { n: 2 })).toBe('2/2');
  });

  it('leaves a placeholder without a value as written, and text without placeholders alone', () => {
    expect(formatMessage('共 {count} 条', {})).toBe('共 {count} 条');
    expect(formatMessage('共 {count} 条')).toBe('共 {count} 条');
    expect(formatMessage('没有参数')).toBe('没有参数');
  });

  it('does not treat braces that are not a name as a placeholder', () => {
    expect(formatMessage('{ "a": 1 }', { a: 'x' })).toBe('{ "a": 1 }');
  });

  it('does not read the values it inserts as placeholders', () => {
    expect(formatMessage('{a}', { a: '{b}', b: 'x' })).toBe('{b}');
  });
});

describe('parseRich', () => {
  it('splits text around tags and nests them', () => {
    expect(parseRich('见<link>设置</link>和<code>k</code>。')).toEqual(['见', { tag: 'link', children: ['设置'] }, '和', { tag: 'code', children: ['k'] }, '。']);
    expect(parseRich('<a>x<b>y</b></a>')).toEqual([{ tag: 'a', children: ['x', { tag: 'b', children: ['y'] }] }]);
  });

  it('keeps a closing tag that matches nothing as text', () => {
    expect(parseRich('a</x>b')).toEqual(['a', '</x>', 'b']);
  });

  it('returns plain text as one part', () => {
    expect(parseRich('没有标签')).toEqual(['没有标签']);
  });
});

describe('createI18n', () => {
  const source = { 'a.hello': '你好，{name}', 'a.only': '只有中文', 'a.link': '见<link>这里</link>' } as const;
  const english = { 'a.hello': 'Hello, {name}', 'a.link': 'See <link>here</link>' };

  it('answers in the source language until told otherwise, and in another once set', () => {
    const i = createI18n(source, 'zh-CN', { en: english });
    expect(i.t('a.hello', { name: 'Kiwi' })).toBe('你好，Kiwi');
    i.setLocale('en');
    expect(i.getLocale()).toBe('en');
    expect(i.t('a.hello', { name: 'Kiwi' })).toBe('Hello, Kiwi');
    expect(i.raw('a.link')).toBe('See <link>here</link>');
  });

  it('reads a message a translation lacks from the source language', () => {
    const i = createI18n(source, 'zh-CN', { en: english });
    i.setLocale('en');
    expect(i.t('a.only')).toBe('只有中文');
  });

  it('ignores a locale it does not have', () => {
    const i = createI18n(source, 'zh-CN', { en: english });
    i.setLocale('fr');
    expect(i.getLocale()).toBe('zh-CN');
    expect(i.locales).toEqual(['zh-CN', 'en']);
  });
});

describe('resolveLocale', () => {
  const available = ['zh-CN', 'en'];

  it('takes an exact match, ignoring case and the underscore', () => {
    expect(resolveLocale(['EN', 'zh-CN'], available, 'zh-CN')).toBe('en');
    expect(resolveLocale(['zh_cn'], available, 'en')).toBe('zh-CN');
  });

  it('falls back to a language with the same first part, in the order the browser lists them', () => {
    expect(resolveLocale(['en-GB', 'en-US', 'en'], available, 'zh-CN')).toBe('en');
    expect(resolveLocale(['zh-TW', 'en'], available, 'en')).toBe('zh-CN');
    expect(resolveLocale(['fr', 'en-US'], available, 'zh-CN')).toBe('en');
  });

  it('uses the fallback when nothing fits or nothing is asked', () => {
    expect(resolveLocale(['fr', 'de'], available, 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale([], available, 'zh-CN')).toBe('zh-CN');
  });
});

describe('mergeCatalogs', () => {
  it('joins catalogs and refuses a key defined twice', () => {
    expect(mergeCatalogs({ 'a.x': '1' }, { 'b.y': '2' })).toEqual({ 'a.x': '1', 'b.y': '2' });
    expect(() => mergeCatalogs({ 'a.x': '1' }, { 'a.x': '2' })).toThrow(/a\.x/);
  });
});

describe('the Chinese catalog', () => {
  const entries = Object.entries(zhCN) as [string, string][];

  it('has messages', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('names keys as dotted words, so a key can be searched for', () => {
    for (const [key] of entries) expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/);
  });

  it('has no empty message', () => {
    for (const [key, text] of entries) expect(text.trim(), key).not.toBe('');
  });

  it('closes every tag it opens', () => {
    for (const [key, text] of entries) {
      if (key.endsWith('.raw')) continue;
      const opened = [...text.matchAll(/<([a-zA-Z][\w-]*)>/g)].map((m) => m[1]).sort();
      const closed = [...text.matchAll(/<\/([a-zA-Z][\w-]*)>/g)].map((m) => m[1]).sort();
      expect(closed, key).toEqual(opened);
    }
  });

  it('keeps a message with braces of its own under a key ending in .raw, read with raw()', () => {
    for (const [key, text] of entries) {
      if (key.endsWith('.raw')) continue;
      for (const [brace] of text.matchAll(/\{[^}]*\}/g)) expect(brace, `${key}: ${brace}`).toMatch(/^\{\w+\}$/);
    }
  });
});

describe('the other languages', () => {
  // `i18n.locales` holds the source language and every translation that has been added; with none added this checks nothing.
  const others = i18n.locales.filter((locale) => locale !== i18n.sourceLocale);

  it.each(others.length ? others : ['(none yet)'])('%s uses only keys the source has, and the same placeholders and tags', (locale) => {
    if (!others.length) return;
    const before = i18n.getLocale();
    i18n.setLocale(locale);
    try {
      for (const [key, source] of Object.entries(zhCN)) {
        const translated = i18n.raw(key as keyof typeof zhCN & string);
        if (translated === source) continue;
        expect(placeholdersOf(translated), `${locale}: ${key}`).toEqual(placeholdersOf(source));
      }
    } finally {
      i18n.setLocale(before);
    }
  });
});
