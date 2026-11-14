import { createContext, useContext, type ReactNode } from 'react';
import type { KiwiHost } from '../host';

const HostContext = createContext<KiwiHost | null>(null);

export function KiwiHostProvider({ host, children }: { host: KiwiHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useKiwiHost(): KiwiHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('The search interface needs a KiwiHost: mount it with mountSearchApp()');
  return host;
}
