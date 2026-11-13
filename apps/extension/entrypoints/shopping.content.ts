import { BROWSER_ENGINES } from '@kiwi-search/core';
import { runEngineContent } from '../lib/engineContent';

const matches = [...new Set(Object.values(BROWSER_ENGINES).filter((engine) => (engine.modes as readonly string[]).includes('shopping')).flatMap((engine) => engine.matches))];

// Amazon can stream its document long after products are visible. Waiting for
// document_idle misses the search deadline in a minimized worker window.
export default defineContentScript({
  matches,
  allFrames: false,
  runAt: 'document_start',
  main: () => runEngineContent({ early: true }),
});
