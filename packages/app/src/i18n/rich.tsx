import { Fragment, type ReactNode } from 'react';
import { formatMessage, parseRich, type ParamValue, type Params, type RichPart, type Tags } from './runtime';
import { raw, type Catalog, type MessageKey } from './index';

type RichArgs<S extends string> = { tags: Record<Tags<S>, (children: ReactNode) => ReactNode> } & ([Params<S>] extends [never]
  ? { params?: undefined }
  : { params: Record<Params<S>, ParamValue> });

function render(parts: RichPart[], tags: Record<string, (children: ReactNode) => ReactNode>, params?: Record<string, ParamValue>): ReactNode {
  return parts.map((part, index) => {
    if (typeof part === 'string') return <Fragment key={index}>{formatMessage(part, params)}</Fragment>;
    const inner = render(part.children, tags, params);
    return <Fragment key={index}>{tags[part.tag] ? tags[part.tag](inner) : inner}</Fragment>;
  });
}

/**
 * A message with elements inside it. Each `<name>…</name>` in the text is rendered by the function of that name, so a
 * translation can put the link wherever its grammar wants it:
 *
 *     tr('options.start.keys', { tags: { ai: (text) => <a href="#ai">{text}</a> } })
 *
 * Not in the service worker: it pulls React in. Use `t` there.
 */
export function tr<K extends MessageKey>(key: K, args: RichArgs<Catalog[K]>): ReactNode {
  return render(parseRich(raw(key)), args.tags as Record<string, (children: ReactNode) => ReactNode>, args.params as Record<string, ParamValue> | undefined);
}
