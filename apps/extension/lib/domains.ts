const HOST = /^(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,}$/;

/** "https://www.Example.com/path?q=1" → "example.com"; null when what was typed isn't a host name. */
export function normalizeDomain(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/[/?#:].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return HOST.test(host) ? host : null;
}

/** Splits pasted text on spaces, commas and newlines into host names, dropping repeats; what isn't a host name comes back as `rejected`. */
export function parseDomains(text: string): { domains: string[]; rejected: string[] } {
  const domains: string[] = [];
  const rejected: string[] = [];
  for (const part of text.split(/[\s,，;；]+/).filter(Boolean)) {
    const domain = normalizeDomain(part);
    if (!domain) rejected.push(part);
    else if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains, rejected };
}

/** `list` plus what `text` adds, without repeats. */
export function addDomains(list: string[], text: string): { list: string[]; rejected: string[] } {
  const { domains, rejected } = parseDomains(text);
  return { list: [...list, ...domains.filter((domain) => !list.includes(domain))], rejected };
}
