import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { promptWithBuiltinModel } from './builtinModel';
import { createSearchSessionController } from './searchSessionController';
import type { SearchState } from './searchState';

/** React subscribes to a port controller whose cancellation and ordering are tested independently. */
export function useSearchSession() {
  const [state, setState] = useState<SearchState | null>(null);
  const controllerRef = useRef<ReturnType<typeof createSearchSessionController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createSearchSessionController({
    connect: (name) => browser.runtime.connect({ name }), prompt: promptWithBuiltinModel, onChange: setState,
  });
  const controller = controllerRef.current;
  useEffect(() => () => controller.dispose(), [controller]);
  return { state, search: controller.search, reset: controller.reset, stop: controller.stop,
    restore: controller.restore, summarize: controller.summarize, stopSummary: controller.stopSummary };
}
