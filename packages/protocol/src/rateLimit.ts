/** Allows `max` calls per `windowMs` for each key; the clock is a parameter so tests do not wait. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const calls = new Map<string, number[]>();
  return (key) => {
    const t = now();
    const recent = (calls.get(key) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= max) { calls.set(key, recent); return false; }
    recent.push(t);
    calls.set(key, recent);
    // Keys come from tab ids; forget the ones that have gone quiet so the map cannot grow without end.
    if (calls.size > 256) for (const [k, v] of calls) if (v.every((at) => t - at >= windowMs)) calls.delete(k);
    return true;
  };
}
