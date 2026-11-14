import type { ReactNode } from 'react';
import { useKiwiHost } from '../lib/hostContext';

/** A link to the settings, optionally at a section. The host decides how it opens: a new tab, or a request to the extension. */
export function OptionsLink({ section, children }: { section?: string; children: ReactNode }) {
  const host = useKiwiHost();
  const href = section ? `${host.optionsUrl}#${section}` : host.optionsUrl;
  if (!host.openOptions) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  const open = host.openOptions;
  return <a href={href} onClick={(event) => { event.preventDefault(); open(section); }}>{children}</a>;
}
