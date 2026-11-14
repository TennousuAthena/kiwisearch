import type { Citation } from '@kiwi-search/core';
import { useMemo } from 'react';
import { t } from '../i18n';
import { SparkleIcon } from '../lib/icons';
import { renderSummary } from '../lib/markdown';
import type { QuickAnswerContent } from '../lib/quickAnswer';

interface Props {
  answer: QuickAnswerContent;
  citations: Citation[];
  onHoverCite: (n: number | null) => void;
}

/** A short answer always belongs to the result column, including on wide screens. */
export function QuickAnswer({ answer, citations, onHoverCite }: Props) {
  const html = useMemo(() => renderSummary(answer.detail, citations), [answer.detail, citations]);
  const highlight = (target: EventTarget) => {
    const n = (target as HTMLElement).closest('a.cite')?.getAttribute('data-n');
    onHoverCite(n ? Number(n) : null);
  };
  return (
    <section className="quick-answer" aria-labelledby="quick-answer-title">
      <p className="quick-answer-label"><SparkleIcon />{t('newtab.quickAnswer.title')}</p>
      <h2 id="quick-answer-title" className="quick-answer-headline">{answer.headline}</h2>
      <div
        className="quick-answer-detail md"
        onMouseOver={(event) => highlight(event.target)}
        onMouseOut={() => onHoverCite(null)}
        onFocus={(event) => highlight(event.target)}
        onBlur={() => onHoverCite(null)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  );
}
