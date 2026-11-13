import { BROWSER_ENGINES } from '@kiwi-search/core';
import { runEngineContent } from '../lib/engineContent';

const matches = [...new Set(Object.values(BROWSER_ENGINES).filter((engine) => !(engine.modes as readonly string[]).includes('shopping')).flatMap((engine) => engine.matches))];

export default defineContentScript({
  matches,
  allFrames: false,
  runAt: 'document_idle',
  main: () => runEngineContent(),
});
