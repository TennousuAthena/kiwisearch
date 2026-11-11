import { DEFAULT_CONFIG } from '../src/config';
import type { Env, SourceContext, SourceSettings } from '../src/types';

export function sourceContext(env: Env, settings: SourceSettings, extra: Partial<SourceContext> = {}): SourceContext {
  return {
    env,
    settings,
    mode: 'web',
    count: 7,
    signal: new AbortController().signal,
    onBlocked: () => {},
    onStart: () => {},
    renderer: DEFAULT_CONFIG.renderer,
    ...extra,
  };
}
