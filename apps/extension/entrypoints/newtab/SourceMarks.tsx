import type { FusedResult } from '@kiwi-search/core';
import type { CSSProperties } from 'react';
import { MARK_ART, type MarkArt } from '@/lib/sourceIcons';
import { marksLabel, sourceMarks } from '@/lib/sourceMarks';

/**
 * The engines that agree on a result, as a few small marks after its site name: three at most, fading to the right, the
 * rest folded until the row is hovered or focused (the fold and the fade are in style.css). Nothing for a result only
 * one engine returned.
 */
export function SourceMarks({ sources }: { sources: FusedResult['sources'] }) {
  const marks = sourceMarks(sources);
  if (!marks.length) return null;
  return (
    <span className="src-marks" tabIndex={0} role="group" aria-label={marksLabel(marks)}>
      {marks.map(({ mark, name }, i) => {
        const art: MarkArt = MARK_ART[mark];
        return (
          <span key={mark} className="src-mark" title={name} aria-hidden="true" style={{ '--i': i } as CSSProperties}>
            <picture>
              {art.dark && <source media="(prefers-color-scheme: dark)" srcSet={art.dark} />}
              <img src={art.src} alt="" width={15} height={15} draggable={false} className={art.invertInDark ? 'inv' : undefined} />
            </picture>
          </span>
        );
      })}
    </span>
  );
}
