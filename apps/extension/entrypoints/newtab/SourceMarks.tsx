import type { FusedResult } from '@kiwi-search/core';
import type { CSSProperties } from 'react';
import { t } from '@/lib/i18n';
import { MARK_ART, type MarkArt } from '@/lib/sourceIcons';
import { marksLabel, sourceMarks } from '@/lib/sourceMarks';
import { useResolvedTheme } from '@/lib/uiPreferences';
import { ResultPopover } from './ResultPopover';

/**
 * The engines that returned a result, as small round marks after its site name, stacked tight and fanning out when the row
 * is hovered or focused (the stack is in style.css). A result only one engine returned gets that engine's mark alone,
 * drawn faint (`solo`) so it does not compete with the title.
 */
export function SourceMarks({ sources }: { sources: FusedResult['sources'] }) {
  const theme = useResolvedTheme();
  const marks = sourceMarks(sources);
  if (!marks.length) return null;
  const picture = (art: MarkArt) => <img src={theme === 'dark' && art.dark ? art.dark : art.src} alt="" width={15} height={15} draggable={false} className={art.invertInDark ? 'inv' : undefined} />;
  return (
    <ResultPopover label={marksLabel(marks)} triggerClass={marks.length === 1 ? 'src-marks solo' : 'src-marks'} trigger={
      marks.slice(0, 3).map(({ mark, name }, i) => <span key={mark} className="src-mark" title={name} aria-hidden="true" style={{ '--i': i } as CSSProperties}>{picture(MARK_ART[mark])}</span>)
    }>
      {() => <>
        <p className="result-ux-popover-title">{t('resultUx.sources.title')}</p>
        <ul className="result-ux-source-list">{marks.map(({ mark, name }) => <li key={mark}>{picture(MARK_ART[mark])}<span>{name}</span></li>)}</ul>
        <p className="result-ux-popover-note result-ux-separator">{t('resultUx.sources.note')}</p>
      </>}
    </ResultPopover>
  );
}
