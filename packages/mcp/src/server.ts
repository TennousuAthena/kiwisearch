import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeReply, BridgeRequest, BridgeHub, RelayClient } from './bridge';

export type BridgeTransport = Pick<BridgeHub | RelayClient, 'request'>;

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

function blockedNote(sources: string[]): string {
  return sources.length ? `\n\n尚未完成验证的来源：${sources.join('、')}。结果可能不完整。` : '';
}

function formatSearchResult(result: Record<string, unknown>): { text: string; structured: Record<string, unknown> } {
  const results = Array.isArray(result.results) ? result.results as Record<string, unknown>[] : [];
  const blocked = blockedSourceIds(result);
  const entries = results.map((item, index) => {
    const title = String(item.title ?? '无标题');
    const url = String(item.url ?? '');
    const sources = Array.isArray(item.sources)
      ? (item.sources as { source?: string; rank?: number }[]).map((source) => `${source.source ?? '未知'} #${source.rank ?? '?'}`).join('、')
      : '';
    return `${index + 1}. [${title}](${url})${sources ? ` — ${sources}` : ''}\n\n   ${String(item.snippet ?? '')}`;
  });
  return {
    text: `${entries.length ? entries.join('\n\n') : '没有找到搜索结果。'}${blockedNote(blocked)}`,
    structured: {
      results: results.map((item, index) => ({ n: index + 1, ...item })),
      sourceStats: Array.isArray(result.sourceStats) ? result.sourceStats : [],
      blockedSources: blocked,
    },
  };
}

export function createMcpServer(bridge: BridgeTransport): McpServer {
  const server = new McpServer({ name: 'fusion-search', version: '0.1.0' });
  server.registerTool(
    'search',
    {
      title: '融合搜索',
      description: '通过当前浏览器的搜索来源执行融合检索，返回带来源与排名的结果。',
      inputSchema: {
        query: z.string().min(1),
        sources: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, sources, limit }, extra) => {
      try {
        const reply = await callBridge(bridge, { type: 'search', query, options: { sources, limit: limit ?? 10, summarize: false } }, extra);
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
      inputSchema: { query: z.string().min(1), sources: z.array(z.string()).optional() },
    },
    async ({ query, sources }, extra) => {
      try {
        const result = pipelineResult(await callBridge(bridge, { type: 'answer', query, options: { sources, summarize: true } }, extra));
        const summary = String(result.summary ?? '');
        const blocked = blockedSourceIds(result);
        if (!summary && blocked.length === 0) throw new Error('未能生成摘要，请检查 LLM 设置或来源结果。');
        const citations = Array.isArray(result.citations) ? result.citations as Record<string, unknown>[] : [];
        const references = citations.map((citation) => `[${citation.n}] [${citation.title}](${citation.url})`).join('\n');
        return textResult(
          `${summary || '未生成摘要。'}${references ? `\n\n## 引用\n${references}` : ''}${blockedNote(blocked)}`,
          {
            summary,
            citations,
            sourceStats: Array.isArray(result.sourceStats) ? result.sourceStats : [],
            blockedSources: blocked,
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
