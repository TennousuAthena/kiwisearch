import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

/** One lookup per host for the life of the page: result lists repeat hosts a lot. */
const lookups = new Map<string, Promise<string | null>>();

function lookup(host: string): Promise<string | null> {
  let request = lookups.get(host);
  if (!request) {
    request = (browser.runtime.sendMessage({ type: 'kiwi:favicon', host }) as Promise<{ src?: string | null } | undefined>)
      .then((reply) => reply?.src ?? null)
      .catch(() => null);
    lookups.set(host, request);
  }
  return request;
}

/** The site's icon in the round badge in front of a result; until it arrives, or when the site has none, the first letter of the site name. */
export function Favicon({ host, label }: { host: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setSrc(null);
    if (host) void lookup(host).then((found) => current && setSrc(found));
    return () => {
      current = false;
    };
  }, [host]);
  if (src) return <img src={src} alt="" width={28} height={28} onError={() => setSrc(null)} />;
  return (
    <span className="site-fallback" aria-hidden="true">
      {Array.from(label)[0]?.toUpperCase()}
    </span>
  );
}
