import { errorMessage, withTimeout } from './http';
import { postSystemOne, type SystemOneResponse } from './judge';
import type { Env, FusionConfig, Route } from './types';

/** The extra kinds of source a general search can switch on. */
export const ROUTES: Route[] = ['academic', 'zhihu', 'xiaohongshu', 'wechat'];

/**
 * One System One request about the query alone: is it worth also searching scholarly sources, a Q&A community, a lifestyle
 * post feed? Independent yes/no questions, answered in parallel; code applies the threshold.
 */
export function buildIntentRequest(query: string, model: string) {
  return {
    model,
    state: { query },
    questions: {
      academic: {
        type: 'noul',
        instructions:
          'Is `query` asking for scholarly or scientific literature: research papers, studies, experiments, methods and their citations, surveys, or a technical research topic that a researcher would look up in an academic database?',
        criteria: {
          true: 'The query names a research topic, method, model, dataset, author or paper, or asks what research says about something',
          false: 'The query is about everyday information, products, news, entertainment, how-to help, or a general fact that needs no scholarly sources',
        },
      },
      zhihu: {
        type: 'noul',
        instructions:
          'Would answers from a Chinese Q&A and discussion community (like Zhihu) help with `query`? Such sites are strong on explanations, opinions and experience: how to evaluate something, why something is the case, comparisons, recommendations, career, study and relationship advice, literature and film discussion, and professional or cultural debates.',
        criteria: {
          true: 'People discussing, explaining or sharing experience would be a good answer to this query',
          false:
            'The query is a plain lookup that official or reference pages answer: a definition, a date, a price, a product page, software documentation, news, weather, or a person\'s or company\'s website',
        },
      },
      xiaohongshu: {
        type: 'noul',
        instructions:
          'Would short lifestyle posts with photos from everyday users (like Xiaohongshu notes) help with `query`? They are strong on travel spots and itineraries, food and restaurants, product and cosmetics reviews, fashion and outfits, home decor, recipes, fitness and study routines, and daily-life tips.',
        criteria: {
          true: 'Photos and first-hand lifestyle posts would be a good answer to this query',
          false: 'The query is technical, academic, political, financial, news-related or factual and gains nothing from lifestyle posts',
        },
      },
      wechat: {
        type: 'noul',
        instructions:
          'Would articles from WeChat official accounts (微信公众号) help with `query`? They are strong on in-depth commentary and analysis, explainers and follow-ups on news, industry and company information, tutorials and how-to notes, exam, job and policy information, local life, health knowledge, investing and personal finance views, and writing by niche experts and organizations whose content is hard to find elsewhere.',
        criteria: {
          true: 'Articles published by official accounts (media, companies, institutions, experts) would be a good answer to this query',
          false: 'The query is a plain lookup that reference pages answer, a documentation or product-page query, or something only photos or short posts would answer',
        },
      },
    },
  };
}

export interface IntentVerdict {
  /** Routes at or above the threshold. */
  routes: Route[];
  scores: Partial<Record<Route, number>>;
  /** Set when the verdict could not be had; the search then stays on the general sources. */
  error?: string;
}

export async function judgeIntent(query: string, config: FusionConfig, env: Env, signal?: AbortSignal): Promise<IntentVerdict> {
  const { judge, intent } = config;
  const deadline = withTimeout(signal, intent.timeoutMs);
  try {
    const { answers } = await postSystemOne<SystemOneResponse>(env, judge, buildIntentRequest(query, judge.model), deadline.signal);
    const scores: Partial<Record<Route, number>> = {};
    for (const route of ROUTES) {
      const value = answers[route]?.noul;
      if (typeof value === 'number') scores[route] = value;
    }
    return { routes: ROUTES.filter((route) => (scores[route] ?? 0) >= intent.threshold), scores };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { routes: [], scores: {}, error: deadline.signal.aborted ? `超过 ${intent.timeoutMs}ms，只搜索通用来源` : errorMessage(e) };
  } finally {
    deadline.cancel();
  }
}
