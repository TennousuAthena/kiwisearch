import type { CoreMessages } from '@kiwi-search/core';
import { t } from './index';

/**
 * The few sentences core writes for the user, in the interface language: passed to core as `Env.messages`. Built at each
 * search, so a language chosen since the last one counts at once.
 */
export function coreMessagesFor(): CoreMessages {
  return {
    noAiModel: t('core.noAiModel'),
    planInvalid: t('core.planInvalid'),
    judgeEmpty: t('core.judgeEmpty'),
    decisionNotJson: t('core.decisionNotJson'),
    noDecisionModel: t('core.noDecisionModel'),
    judgeTimedOut: (ms) => t('core.judgeTimedOut', { ms }),
    intentTimedOut: (ms) => t('core.intentTimedOut', { ms }),
    customListName: t('core.customListName'),
  };
}
