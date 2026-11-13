import type { Citation, SearchMode } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { extractQuickAnswer } from '../lib/quickAnswer';
import type { SummaryStatus } from '../lib/searchState';

const citations: Citation[] = [
  { n: 1, url: 'https://example.gov.hk/districts', title: 'District administration' },
  { n: 2, url: 'https://example.gov.cn/population', title: 'Population statistics' },
];
const parse = (summary: string, summaryStatus: SummaryStatus = 'done', mode: SearchMode = 'web', refs = citations) => extractQuickAnswer({ summary, summaryStatus, mode, citations: refs });
const answer = '# 18 个区\n\n香港共分为 18 个行政区，包括香港岛、九龙及新界。[1]';

describe('quick answer presentation contract', () => {
  it('extracts a complete cited factual answer without duplicating it in an overview', () => {
    expect(parse(answer)).toEqual({ headline: '18 个区', detail: '香港共分为 18 个行政区，包括香港岛、九龙及新界。[1]', remainder: '' });
    expect(parse('# 1,798.95 万人（2024 年末）\n\n深圳年末常住人口为 1,798.95 万人，统计口径为常住人口。[2]')?.headline).toBe('1,798.95 万人（2024 年末）');
  });

  it('accepts CRLF and surrounding whitespace, while keeping later overview text and citation IDs', () => {
    const content = ` \r\n${answer.replaceAll('\n', '\r\n')}\r\n\r\n## Further context\r\n\r\nDetails.[2]`;
    expect(parse(content)?.remainder).toBe('## Further context\n\nDetails.[2]');
    expect(parse('# Two sources\n\nThe evidence agrees.[1][2]')?.detail).toBe('The evidence agrees.[1][2]');
  });

  it('waits for a complete paragraph instead of promoting a partial streamed claim', () => {
    expect(parse('# 18', 'streaming')).toBeNull();
    expect(parse('# 18 个区\n\n香港', 'streaming')).toBeNull();
    expect(parse(answer, 'streaming')).toBeNull();
    expect(parse(`${answer}\n\n`, 'streaming')?.headline).toBe('18 个区');
    expect(parse(`${answer}\n\n## More`, 'streaming')?.remainder).toBe('## More');
  });

  it('leaves ordinary overviews and other search modes unchanged', () => {
    for (const text of ['A normal answer.[1]', '## Overview\n\nA normal answer.[1]', '# Title\nA paragraph.[1]', '# Title\n\n', '# Title']) {
      expect(parse(text)).toBeNull();
    }
    for (const mode of ['news', 'academic', 'shopping', 'zhihu', 'images', 'video', 'wechat', 'x', 'xiaohongshu'] as SearchMode[]) {
      expect(parse(answer, 'done', mode)).toBeNull();
    }
  });

  it('never promotes failed or unstarted summary output', () => {
    for (const status of ['error', 'idle', 'loading', 'starting'] as SummaryStatus[]) expect(parse(answer, status)).toBeNull();
  });

  it('requires real citations, rejecting unknown, disguised and unsafe references', () => {
    for (const detail of ['No sources.', 'Claim.[0]', 'Claim.[01]', 'Claim.[3]', 'Claim.[100]', 'Claim.[1][9]', 'Claim.[1](https://evil.example)', 'Claim.[1][source]', 'Claim.\\[1]', 'Claim.`[1]`', 'Claim.![1]', 'Claim.<span>[1]</span>']) {
      expect(parse(`# Answer\n\n${detail}`)).toBeNull();
    }
    expect(parse(answer, 'done', 'web', [])).toBeNull();
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      expect(parse(answer, 'done', 'web', [{ ...citations[0], url }])).toBeNull();
    }
  });

  it('requires a compact plain headline and prose detail, without truncating claims', () => {
    for (const headline of ['', 'a'.repeat(101), '**18** districts', '18 districts [1]', '<img src=x onerror=alert(1)>', '18 districts #', 'a\nb']) {
      expect(parse(`# ${headline}\n\nExplanation.[1]`)).toBeNull();
    }
    for (const detail of ['a'.repeat(701) + '[1]', '- List item.[1]', '> Quoted claim.[1]', '## Subheading [1]', '1. List item.[1]', '| Table | [1]', '```\n[1]\n```']) {
      expect(parse(`# Answer\n\n${detail}`)).toBeNull();
    }
  });
});
