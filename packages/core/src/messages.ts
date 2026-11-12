import type { Env } from './types';

/**
 * The few sentences core writes that end up in front of the user: the reason a feature was skipped, the name of the user's own
 * block rules. Everything else core says is data (titles, snippets) or a prompt for a model.
 *
 * The caller can pass its own wording in `Env.messages` (the extension fills it from its message catalog, in the interface
 * language); whatever it leaves out is read from `DEFAULT_CORE_MESSAGES`, so a bare `Env` (tests, MCP) still gets sentences.
 */
export interface CoreMessages {
  /** Smart academic search is on but there is no AI model to ask. */
  noAiModel: string;
  /** The model answered the academic plan with something that is not a plan. */
  planInvalid: string;
  /** The decision model answered, but with no verdict that could be used. */
  judgeEmpty: string;
  /** The decision model's reply was not JSON. */
  decisionNotJson: string;
  /** No decision model is set up to ask. */
  noDecisionModel: string;
  /** Filtering stopped waiting after `ms`; the verdicts that had come in are used. */
  judgeTimedOut: (ms: number) => string;
  /** Intent detection stopped waiting after `ms`; only the general sources are searched. */
  intentTimedOut: (ms: number) => string;
  /** What the user's own block rules are called when a result is hidden by them. */
  customListName: string;
}

export const DEFAULT_CORE_MESSAGES: CoreMessages = {
  noAiModel: '没有可用的 AI 模型',
  planInvalid: '模型的回复不是有效的检索计划',
  judgeEmpty: '决策模型没有给出可用的判定',
  decisionNotJson: '决策模型的回复不是 JSON',
  noDecisionModel: '没有可用的决策模型',
  judgeTimedOut: (ms) => `超过 ${ms}ms，已使用已返回的判定`,
  intentTimedOut: (ms) => `超过 ${ms}ms，只搜索通用来源`,
  customListName: '自定义规则',
};

export function coreMessages(env: Pick<Env, 'messages'>): CoreMessages {
  return { ...DEFAULT_CORE_MESSAGES, ...env.messages };
}
