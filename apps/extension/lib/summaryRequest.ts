/** True only for this extension's own pages (the new-tab page and the settings page), whatever their query or hash. */
export function isExtensionPageSender(sender: { id?: string; url?: string } | undefined, id: string, baseUrl: string): boolean {
  if (sender?.id !== id || !sender.url) return false;
  try {
    const url = new URL(sender.url); const base = new URL(baseUrl);
    return url.protocol === base.protocol && url.host === base.host && ['/newtab.html', '/options.html'].includes(url.pathname);
  } catch { return false; }
}
