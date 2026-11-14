import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeReply, BridgeRequest, BridgeHub, RelayClient } from './bridge';
import type { BridgeSession } from './session';

export type BridgeTransport = Pick<BridgeHub | RelayClient | BridgeSession, 'request'>;

const modeSchema = z
  .enum(['web', 'images', 'video', 'news', 'shopping', 'academic', 'zhihu', 'xiaohongshu', 'wechat', 'x'])
  .optional()
  .describe('web (default), images (image file URLs), video, news (articles with publisher and publication evidence), shopping (products with displayed price, shop and thumbnail when available), zhihu, xiaohongshu, wechat, x or academic (papers with authors, year, venue, citations, PDF)');

const newsSchema = z.object({
  range: z.enum(['any', 'day', 'week', 'month']).optional().describe('Rolling publication window: any (default), 24 hours, 7 days or 30 days. Unknown publication dates are hidden for a limited range.'),
  sort: z.enum(['relevance', 'date']).optional().describe('relevance (default), or newest known publication first'),
}).optional().describe('news mode only');
const refreshSchema = z.boolean().optional().describe('Bypass cached source results for this request; browser queues and rate limits still apply');

const languageSchema = z
  .enum(['any', 'en'])
  .optional()
  .describe('academic mode only: en keeps English-language papers (the rest come back under hidden with reason "language"); any (default) limits nothing');

interface ToolContext {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
}

async function callBridge(
  bridge: BridgeTransport,
  request: BridgeRequest,
  extra: unknown,
): Promise<BridgeReply> {
  const context = extra as ToolContext;
  let progress = 0;
  return bridge.request(request, context.signal, (message) => {
    if (context._meta?.progressToken === undefined || !context.sendNotification) return;
    progress += 1;
    const detail = message.event ? JSON.stringify(message.event) : '正在搜索';
    void context.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: context._meta.progressToken, progress, message: detail },
    });
  });
}

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { ...textResult(message), isError: true };
}

function pipelineResult(reply: BridgeReply): Record<string, unknown> {
  if (reply.type !== 'result' || !reply.result || typeof reply.result !== 'object') throw new Error(reply.error ?? '浏览器插件未返回结果');
  return reply.result as Record<string, unknown>;
}

function blockedSourceIds(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.sourceStats)) return [];
  return (result.sourceStats as { source?: unknown; status?: unknown }[])
    .filter((stat) => stat.status === 'blocked' && typeof stat.source === 'string')
    .map((stat) => stat.source as string);
}

/** What is missing and why: a captcha the user has to solve, or a site the browser isn't signed in to. */
function blockedNote(result: Record<string, unknown>): string {
  const stats = Array.isArray(result.sourceStats) ? (result.sourceStats as { source?: unknown; status?: unknown; blockedReason?: unknown }[]) : [];
  const blocked = stats.filter((stat) => stat.status === 'blocked' && typeof stat.source === 'string');
  const ids = (reason: 'login' | 'captcha') => blocked.filter((stat) => (stat.blockedReason === 'login' ? 'login' : 'captcha') === reason).map((stat) => stat.source as string);
  const captcha = ids('captcha');
  const login = ids('login');
  return [
    captcha.length ? `\n\n尚未完成验证的来源：${captcha.join('、')}。结果可能不完整。` : '',
    login.length ? `\n\n需要先在浏览器里登录的来源：${login.join('、')}。结果可能不完整。` : '',
  ].join('');
}

interface ResultMeta {
  authors?: string[];
  venue?: string;
  year?: number;
  citations?: number;
  pdfUrl?: string;
  author?: string;
  votes?: number;
  comments?: number;
  age?: string;
  reposts?: number;
  views?: number;
  siteName?: string;
}

/** Extra line for specialized results so agents get more than a title and URL. */
function detailLine(item: Record<string, unknown>): string {
  const product = item.product as { price?: string; shop?: string; sales?: string; rating?: string } | undefined;
  if (product) {
    const details = [product.price ? `页面价格 ${product.price}` : '', product.shop, product.sales, product.rating].filter(Boolean);
    return details.length ? `商品：${details.join(' · ')}` : '';
  }
  const news = item.news as { publisher?: string; byline?: string; timeKind?: string; timeText?: string; updatedAt?: string; retrievedAt?: string } | undefined;
  if (news) {
    const time = news.timeKind === 'published' && typeof item.publishedAt === 'string' ? `发布于 ${item.publishedAt}`
      : news.timeKind === 'updated' && news.updatedAt ? `更新于 ${news.updatedAt}` : news.timeText || '发布时间未知';
    return `新闻：${[news.publisher, news.byline, time, news.retrievedAt ? `检索于 ${news.retrievedAt}` : ''].filter(Boolean).join(' · ')}`;
  }
  const image = item.image as { src?: string; width?: number; height?: number; license?: string } | undefined;
  if (image?.src) {
    const size = image.width && image.height ? `${image.width}×${image.height}` : '';
    return `图片：${[image.src, size, image.license].filter(Boolean).join(' · ')}`;
  }
  const video = item.video as { channel?: string; duration?: string; views?: string; published?: string } | undefined;
  if (video) return `视频：${[video.channel, video.duration, video.views, video.published].filter(Boolean).join(' · ')}`;
  const note = item.note as { author?: string; time?: string; likes?: string } | undefined;
  if (note) return `笔记：${[note.author, note.time, note.likes ? `${note.likes}赞` : ''].filter(Boolean).join(' · ')}`;
  const meta = (item.meta ?? {}) as ResultMeta;
  if (meta.siteName === 'X') {
    const posted = typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 10) : '';
    const counts = [
      meta.comments !== undefined ? `${meta.comments} 回复` : '',
      meta.reposts !== undefined ? `${meta.reposts} 转发` : '',
      meta.votes !== undefined ? `${meta.votes} 喜欢` : '',
      meta.views !== undefined ? `${meta.views} 浏览` : '',
    ];
    return `X：${[meta.author, posted, ...counts].filter(Boolean).join(' · ')}`;
  }
  if (meta.siteName === '微信公众号') {
    const published = typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 10) : '';
    return `公众号：${[meta.author, published].filter(Boolean).join(' · ')}`;
  }
  if (meta.author !== undefined || meta.votes !== undefined) {
    const counts = [meta.votes !== undefined ? `${meta.votes} 赞同` : '', meta.comments !== undefined ? `${meta.comments} 评论` : ''];
    return `知乎：${[meta.author, ...counts, meta.age].filter(Boolean).join(' · ')}`;
  }
  const parts = [
    meta.authors?.length ? meta.authors.slice(0, 4).join(', ') + (meta.authors.length > 4 ? ' 等' : '') : '',
    meta.venue,
    meta.year,
    meta.citations !== undefined ? `被引 ${meta.citations}` : '',
    meta.pdfUrl ? `PDF ${meta.pdfUrl}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function newsSnapshot(result: Record<string, unknown>): { news?: unknown; incomplete?: boolean } {
  if (result.mode !== 'news') return {};
  const stats = Array.isArray(result.sourceStats) ? result.sourceStats as { status?: string; error?: string }[] : [];
  return { news: result.news, incomplete: stats.some((stat) => !!stat.error || stat.status === 'blocked' || stat.status === 'late') };
}

function newsNote(result: Record<string, unknown>): string {
  if (result.mode !== 'news') return '';
  const news = result.news as { summaryAt?: string; requestedAt?: string } | undefined;
  return `\n\n新闻快照：${news?.summaryAt ?? news?.requestedAt ?? '时间未知'}。${newsSnapshot(result).incomplete ? '部分来源未完成或出错，结果可能不完整。' : '仅代表本次检索，不保证覆盖全部新闻。'}`;
}

function hiddenResults(all: Record<string, unknown>[]) {
  return all.filter((item) => item.hidden).map((item) => {
    const why = item.hidden as { reason?: unknown; list?: unknown; detail?: unknown };
    return { title: item.title, url: item.url, reason: why.reason, ...(typeof why.list === 'string' ? { list: why.list } : {}), ...(typeof why.detail === 'string' ? { detail: why.detail } : {}) };
  });
}

function formatSearchResult(result: Record<string, unknown>): { text: string; structured: Record<string, unknown> } {
  const all = Array.isArray(result.results) ? result.results as Record<string, unknown>[] : [];
  const results = all.filter((item) => !item.hidden);
  const hidden = hiddenResults(all);
  const blocked = blockedSourceIds(result);
  const entries = results.map((item, index) => {
    const title = String(item.title ?? '无标题');
    const url = String(item.url ?? '');
    const sources = Array.isArray(item.sources)
      ? (item.sources as { source?: string; rank?: number }[]).map((source) => `${source.source ?? '未知'} #${source.rank ?? '?'}`).join('、')
      : '';
    const detail = detailLine(item);
    return `${index + 1}. [${title}](${url})${sources ? ` — ${sources}` : ''}${detail ? `\n\n   ${detail}` : ''}\n\n   ${String(item.snippet ?? '')}`;
  });
  const plan = result.plan && typeof result.plan === 'object' ? (result.plan as { intent?: string; keywords?: string[] }) : undefined;
  const landmarks = Array.isArray(result.landmarks) ? (result.landmarks as { title?: string; year?: number }[]) : [];
  const planNote = plan
    ? `检索理解：${plan.intent ?? ''}${plan.keywords?.length ? `（关键词：${plan.keywords.join('、')}）` : ''}${landmarks.length ? `\n已核对存在的核心文献：${landmarks.map((l) => `${l.title}${l.year ? `（${l.year}）` : ''}`).join('；')}` : ''}\n\n`
    : '';
  const hiddenNote = hidden.length ? `\n\n另有 ${hidden.length} 条结果被过滤（低质量、不相关、语言不符、时间不符、命中屏蔽规则，或 Google 跳转链接未能还原），详见 structuredContent.hidden。` : '';
  return {
    text: `${planNote}${entries.length ? entries.join('\n\n') : '没有找到搜索结果。'}${hiddenNote}${blockedNote(result)}${newsNote(result)}`,
    structured: {
      results: results.map((item, index) => ({ n: index + 1, ...item })),
      hidden,
      sourceStats: Array.isArray(result.sourceStats) ? result.sourceStats : [],
      blockedSources: blocked,
      ...newsSnapshot(result),
      ...(plan ? { plan, landmarks } : {}),
    },
  };
}

export function createMcpServer(bridge: BridgeTransport): McpServer {
  const server = new McpServer({ name: 'kiwi-search', version: '0.1.0' });
  server.registerTool(
    'search',
    {
      title: '融合搜索',
      description: '通过当前浏览器的搜索来源执行融合检索，返回带来源与排名的结果。mode 可选择网页、新闻、购物、学术等检索。',
      inputSchema: {
        query: z.string().min(1),
        mode: modeSchema,
        language: languageSchema,
        news: newsSchema,
        refresh: refreshSchema,
        sources: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, mode, language, news, refresh, sources, limit }, extra) => {
      try {
        const reply = await callBridge(bridge, { type: 'search', query, options: { mode, language, news, refresh, sources, limit: limit ?? 10, summarize: false } }, extra);
        const formatted = formatSearchResult(pipelineResult(reply));
        return textResult(formatted.text, formatted.structured);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'answer',
    {
      title: '搜索并回答',
      description: '检索多个来源并生成带 [n] 引用的摘要。',
      inputSchema: { query: z.string().min(1), mode: modeSchema, language: languageSchema, news: newsSchema, refresh: refreshSchema, sources: z.array(z.string()).optional() },
    },
    async ({ query, mode, language, news, refresh, sources }, extra) => {
      try {
        if (mode === 'images' || mode === 'video' || mode === 'shopping' || mode === 'xiaohongshu' || mode === 'x') throw new Error(`answer 不支持 ${mode} 模式（没有可总结的文本），请改用 search。`);
        const result = pipelineResult(await callBridge(bridge, { type: 'answer', query, options: { mode, language, news, refresh, sources, summarize: true } }, extra));
        const summary = String(result.summary ?? '');
        const blocked = blockedSourceIds(result);
        if (!summary && blocked.length === 0) throw new Error('未能生成摘要，请检查 LLM 设置或来源结果。');
        const citations = Array.isArray(result.citations) ? result.citations as Record<string, unknown>[] : [];
        const references = citations.map((citation) => `[${citation.n}] [${citation.title}](${citation.url})`).join('\n');
        return textResult(
          `${summary || '未生成摘要。'}${references ? `\n\n## 引用\n${references}` : ''}${blockedNote(result)}${newsNote(result)}`,
          {
            summary,
            citations,
            sourceStats: Array.isArray(result.sourceStats) ? result.sourceStats : [],
            blockedSources: blocked,
            ...(result.mode === 'news' ? { hidden: hiddenResults(Array.isArray(result.results) ? result.results as Record<string, unknown>[] : []), ...newsSnapshot(result) } : {}),
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'list_sources',
    {
      title: '列出搜索来源',
      description: '查看浏览器插件当前可用的搜索来源与配置状态。',
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const result = pipelineResult(await callBridge(bridge, { type: 'list_sources' }, extra));
        const sources = Array.isArray(result.sources) ? result.sources : [];
        return textResult(JSON.stringify(sources, null, 2), { sources: sources as unknown[] });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  return server;
}
