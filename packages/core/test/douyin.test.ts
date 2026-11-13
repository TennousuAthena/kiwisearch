import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { douyin } from '../src/engines/douyin';

const pageUrl = 'https://www.douyin.com/search/%E5%92%96%E5%95%A1?type=video';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};

describe('Douyin video search (hand-written result fixture based on public frontend code)', () => {
  const doc = dom(fixture('douyin.html'));
  const hits = douyin.extract(doc, pageUrl, 'video');

  it('keeps only video-tab cards, excluding prediction cards and videos from other lists', () => {
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.rank)).toEqual([1, 2]);
    expect(hits[0]).toMatchObject({
      url: 'https://www.douyin.com/video/7000000000000000001',
      host: 'douyin.com',
      title: '手冲咖啡入门 #咖啡',
      snippet: '',
      meta: { votes: 12000 },
      video: { thumbnail: 'https://p3.douyinpic.com/cover-1.jpg', duration: '01:23', channel: '咖啡示例作者', published: '昨天' },
    });
    expect(hits[0].video?.views).toBeUndefined();
    expect(hits[0].video?.channelUrl).toBeUndefined();
    expect(hits[1].video?.thumbnail).toBeUndefined();
    expect(doc.querySelector(douyin.readySelector)).not.toBeNull();
    expect(doc.querySelector(douyin.loginSelector!)).toBeNull();
  });

  it('rejects users, live rooms, foreign URLs and malformed cards, and deduplicates videos', () => {
    const card = (href: string, title = 'Title') => `<li><div class="search-result-card"><a class="_4furHfW" href="${href}"><div class="VDYK8Xd7">${title}</div></a></div></li>`;
    const found = douyin.extract(dom(`<ul class="PAjzsG5a">${[
      card('/video/12345?from=search'), card('//www.douyin.com/video/12345/'),
      card('/user/12345'), card('https://live.douyin.com/12345'),
      card('https://www.douyin.com.evil.example/video/67890'), card('javascript:alert(1)'),
      card('/video/12345/extra'), card('/video/not-an-id'), card('/video/67890', ''),
    ].join('')}</ul>`), pageUrl, 'video');
    expect(found.map((hit) => hit.url)).toEqual(['https://www.douyin.com/video/12345']);
  });

  it('encodes queries as a single path segment and selects the video tab', () => {
    const url = new URL(douyin.buildUrl('咖啡 / 茶?#', 16, 'video'));
    expect(url.pathname).toBe(`/search/${encodeURIComponent('咖啡 / 茶?#')}`);
    expect(url.search).toBe('?type=video');
    expect(douyin.modes).toEqual(['video']);
  });
});

it('recognizes the real signed-out login wall and returns no video results', () => {
  const doc = dom(fixture('douyin-blocked.html'));
  expect(doc.querySelector(douyin.loginSelector!)).not.toBeNull();
  expect(doc.querySelector(douyin.readySelector)).toBeNull();
  expect(doc.querySelector(douyin.blockedSelector)).toBeNull();
  expect(douyin.extract(doc, pageUrl, 'video')).toEqual([]);
});

it('recognizes the real same-URL captcha iframe even when the parent body has no text', () => {
  const doc = dom(fixture('douyin-captcha.html'));
  expect(doc.querySelector(douyin.blockedSelector)).not.toBeNull();
  expect(doc.querySelector(douyin.loginSelector!)).toBeNull();
  expect(doc.querySelector(douyin.readySelector)).toBeNull();
  expect(douyin.extract(doc, pageUrl, 'video')).toEqual([]);
  // Loading the captcha SDK alone does not mean a challenge has been shown.
  const unblocked = dom('<script src="https://lf-cdn-tos.bytescm.com/obj/static/sec_sdk_build/3.5.2/captcha/index.js"></script><iframe src="https://rmc.bytedance.com/other"></iframe>');
  expect(unblocked.querySelector(douyin.blockedSelector)).toBeNull();
});
