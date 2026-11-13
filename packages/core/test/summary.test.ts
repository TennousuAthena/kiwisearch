import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { runSearch } from '../src/pipeline';
import { buildSummaryMessages } from '../src/summarize';
import type { Env, FusedResult, PipelineEvent, SearchMode } from '../src/types';

const now = new Date('2026-11-13T00:00:00Z');
const page: FusedResult = {
  key: 'https://example.gov/statistics',
  url: 'https://example.gov/statistics',
  title: 'Official statistics',
  snippet: 'The population was 12 million residents in 2024.',
  sources: [],
  rrfScore: 1,
  score: 1,
  meta: {},
};

describe('quick-answer prompt contract', () => {
  it('reserves the first H1 only in general web search', () => {
    const web = buildSummaryMessages('How many districts?', [page], new Map(), undefined, now, 'web')[0].content;
    expect(web).toContain('Quick-answer eligibility:');
    expect(web).toContain('the first line MUST be "# "');
    expect(web).toContain('exactly ONE short explanatory paragraph');
    expect(web).toContain('inline [n] citations');
    expect(web).toContain('Stop after this paragraph');
    for (const mode of ['news', 'academic', 'zhihu', 'wechat', 'x', 'images', 'video', 'shopping', 'xiaohongshu'] satisfies SearchMode[]) {
      const prompt = buildSummaryMessages('How many districts?', [page], new Map(), undefined, now, mode)[0].content;
      expect(prompt, mode).not.toContain('Quick-answer eligibility:');
      expect(prompt, mode).not.toContain('the first line MUST be "# "');
      if (mode === 'academic') expect(prompt).toContain('Write a short literature overview');
      if (mode === 'news') expect(prompt).toContain('This is a news evidence snapshot');
    }
  });

  it('requires evidence, dates and statistical scope instead of treating a question mark as sufficient', () => {
    const [system, user] = buildSummaryMessages('深圳市的人口是多少', [page], new Map(), undefined, now);
    expect(system.content).toContain('supplied sources clearly support it');
    expect(system.content).toContain('not the presence of a question mark');
    expect(system.content).toContain('official or primary sources');
    expect(system.content).toContain('evidence year or date');
    expect(system.content).toContain('resident population rather than registered population');
    expect(system.content).toContain('geographic scope');
    expect(system.content).toContain('never imply it is current or the latest');
    expect(user.content).toContain('[1] Official statistics');
    expect(user.content).toContain('12 million residents in 2024');
    expect(user.content).toContain('Query: 深圳市的人口是多少');
  });

  it('keeps unsupported or unsuitable questions in the ordinary overview', () => {
    const prompt = buildSummaryMessages('Which city is best for me?', [page], new Map(), undefined, now)[0].content;
    for (const exclusion of ['navigation', 'open-ended questions', 'opinions', 'recommendations', 'personalized medical/legal/financial advice', 'insufficient evidence', 'unresolved disagreement']) {
      expect(prompt).toContain(exclusion);
    }
    expect(prompt).toContain('In those cases use a regular overview');
    expect(prompt).toContain('## or deeper, never #');
    expect(prompt).toContain('not a label, introduction or repetition of the query');
    expect(prompt).toContain('no Markdown emphasis, links, HTML or citations');
  });

  it('preserves the chosen language and keeps custom style instructions subject to the evidence and format rules', () => {
    const [system, user] = buildSummaryMessages('香港有多少个区', [page], new Map(), 'Always begin with a heading.', now, 'web', 'Japanese');
    expect(system.content).toContain('The answer MUST be written in Japanese');
    expect(user.content.endsWith('(Write your answer in Japanese.)')).toBe(true);
    const custom = system.content.indexOf('Additional instructions: Always begin with a heading.');
    const required = system.content.indexOf('must not override source grounding');
    expect(custom).toBeGreaterThan(0);
    expect(required).toBeGreaterThan(custom);
    expect(system.content.indexOf('Quick-answer eligibility:')).toBeGreaterThan(required);
  });
});

describe('quick answers use the existing summary request', () => {
  function setup() {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = id === 'google';
    config.judge.provider = 'none';
    config.rerank.provider = 'none';
    config.summary = { ...config.summary, enabled: true, provider: 'api', contentFetcher: 'none' };
    config.llm = { ...config.llm, baseUrl: 'http://localhost:11434/v1', model: 'test-model', apiKey: '' };
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const answer = '# 18 districts\n\nHong Kong is divided into 18 districts. [1]';
    const env: Env = {
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      },
      runBrowserEngine: async () => [{ source: 'google', url: page.url, title: page.title, snippet: 'Hong Kong has 18 districts.', rank: 1 }],
    };
    return { config, env, requests, answer };
  }

  it('makes one model request and preserves readable Markdown and citations for other consumers', async () => {
    const { config, env, requests, answer } = setup();
    const events: PipelineEvent[] = [];
    const result = await runSearch('香港有多少个区', config, env, { onEvent: (event) => events.push(event) });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toContain('Quick-answer eligibility:');
    expect(result.summary).toBe(answer);
    expect(result.citations).toEqual([{ n: 1, url: page.url, title: page.title }]);
    expect(events.find((event) => event.type === 'summary_done')).toEqual({ type: 'summary_done', text: answer });
  });

  it('sends the same format instructions to the built-in model without an API request', async () => {
    const { config, env, requests } = setup();
    config.summary.provider = 'chrome-builtin';
    const events: PipelineEvent[] = [];
    await runSearch('香港有多少个区', config, env, { onEvent: (event) => events.push(event) });
    const prompt = events.find((event) => event.type === 'summary_prompt');
    expect(requests).toHaveLength(0);
    expect(prompt?.type === 'summary_prompt' && prompt.messages[0]?.content).toContain('Quick-answer eligibility:');
    expect(prompt?.type === 'summary_prompt' && prompt.citations).toEqual([{ n: 1, url: page.url, title: page.title }]);
  });
});
