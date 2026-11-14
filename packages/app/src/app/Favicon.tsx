import { useEffect, useState } from 'react';
import { useKiwiHost } from '../lib/hostContext';
import type { KiwiHost } from '../host';

/** One lookup per host for the life of the page: result lists repeat hosts a lot. */
const lookups = new Map<string, Promise<string | null>>();

function lookup(favicon: KiwiHost['favicon'], host: string): Promise<string | null> {
  let request = lookups.get(host);
  if (!request) {
    request = favicon(host).catch(() => null);
    lookups.set(host, request);
  }
  return request;
}

/** The site's icon in the round badge in front of a result; until it arrives, or when the site has none, the first letter of the site name. */
export function Favicon({ host, label }: { host: string; label: string }) {
  const { favicon } = useKiwiHost();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setSrc(null);
    if (host) void lookup(favicon, host).then((found) => current && setSrc(found));
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
