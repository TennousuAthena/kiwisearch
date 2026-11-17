import type { SourceId } from '@kiwi-search/core';
import { MARK_ART, type MarkArt } from './sourceIcons';
import { SOURCE_MARKS } from './sourceMarks';
import { useResolvedTheme } from './uiPreferences';
import './sourceLogo.css';

/** A source's real brand logo, decorative (the name is always written next to it). The dark variant is used on the dark page. */
export function SourceLogo({ id, size = 18 }: { id: SourceId; size?: number }) {
  const theme = useResolvedTheme();
  const art: MarkArt = MARK_ART[SOURCE_MARKS[id].mark];
  return <img className={art.invertInDark ? 'source-logo inv' : 'source-logo'} src={theme === 'dark' && art.dark ? art.dark : art.src} alt="" width={size} height={size} draggable={false} />;
}
