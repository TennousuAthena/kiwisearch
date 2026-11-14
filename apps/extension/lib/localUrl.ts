/** The address of a search in the extension's own interface. `web` is the default mode and is left out. */
export function localSearchUrl(base: string, query: string, mode: string): string {
  const params = new URLSearchParams({ q: query });
  if (mode !== 'web') params.set('m', mode);
  return `${base}?${params.toString()}`;
}
