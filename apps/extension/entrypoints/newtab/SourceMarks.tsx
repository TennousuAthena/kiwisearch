import type { FusedResult } from '@kiwi-search/core';
import type { CSSProperties } from 'react';
import { MARK_ART } from '@/lib/sourceIcons';
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
        const art: { path?: string; letter?: string; color: string; colorDark: string } = MARK_ART[mark];
        return (
          <span key={mark} className="src-mark" title={name} aria-hidden="true" style={{ '--c': art.color, '--cd': art.colorDark, '--i': i } as CSSProperties}>
            <svg viewBox="0 0 24 24" width="100%" height="100%" focusable="false">
              {art.path ? (
                <path d={art.path} fill="currentColor" />
              ) : (
                <>
                  <rect width="24" height="24" rx="6" fill="currentColor" />
                  <text x="12" y="17.6" textAnchor="middle">
                    {art.letter}
                  </text>
                </>
              )}
            </svg>
          </span>
        );
      })}
    </span>
  );
}
