import type { SourceId } from '@kiwi-search/core';
import { SOURCE_INFO, type SourceConfirmKey } from './sourceCatalog';

/** The words a step can use instead of the ordinary dialog's (each a message without placeholders). */
type StepText = `source.confirmTitle.${string}` | `source.confirmAction.${string}` | `source.confirmCancel.${string}` | 'options.app.enableConfirm';
type StepKey = Extract<import('@kiwi-search/app/i18n').MessageKey, StepText>;

/**
 * Where the two buttons of a confirmation are: `end` (confirm at the right, the usual place), `start` (confirm at the left) or
 * `stack` (a column in the middle, cancel above confirm). A dialog that asks several times in a row changes it from step to step.
 */
export type ConfirmLayout = 'end' | 'start' | 'stack';

/** One question before a source is switched on. Unset fields use the ordinary dialog's title and buttons. */
export interface ConfirmStep {
  body: SourceConfirmKey;
  title?: StepKey;
  confirm?: StepKey;
  cancel?: StepKey;
  /** Which button is the highlighted one. On the last step for Baidu it is "keep it off". */
  primary?: 'confirm' | 'cancel';
  /** The confirm button stays disabled this long after the step appears, so a run of clicks cannot answer every step. */
  holdMs?: number;
  /** Where the buttons are (see `ConfirmDialog`). Steps that follow one another put the confirm button in different places. */
  layout?: ConfirmLayout;
}

/**
 * Baidu is off by default and the owner wants it to stay that way unless the user really means it: three questions, each asked
 * a little more firmly, and never told apart by a count. The confirm button is at the right, then at the left, then in a column
 * in the middle, so the same click three times lands on "cancel" or on nothing; the later steps also hold it for a moment. The last
 * step has "keep it off" as the highlighted button.
 */
const BAIDU: ConfirmStep[] = [
  { body: 'source.confirm.baidu', layout: 'end' },
  { body: 'source.confirm.baidu2', title: 'source.confirmTitle.baidu2', confirm: 'source.confirmAction.baidu2', holdMs: 800, layout: 'start' },
  { body: 'source.confirm.baidu3', title: 'source.confirmTitle.baidu3', confirm: 'source.confirmAction.baidu3', cancel: 'source.confirmCancel.baidu3', primary: 'cancel', holdMs: 1200, layout: 'stack' },
];

/** The questions asked before `id` is switched on, in order; none for a source that needs no yes. */
export function confirmSteps(id: SourceId): ConfirmStep[] {
  if (id === 'baidu') return BAIDU;
  const body = SOURCE_INFO[id].confirm;
  return body ? [{ body }] : [];
}
