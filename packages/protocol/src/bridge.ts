/**
 * The messages between the website and the extension, over one private `MessagePort`. Rules for changing them are in
 * docs/internals/web-app.md: the protocol number only grows on an incompatible change, inside one number things are only added,
 * and `hello`, `welcome`, `incompatible`, `disabled`, `unavailable` and `openLocal` never change.
 */
export const PROTOCOL_VERSION = 1;
/** The protocol numbers this build understands, oldest first. The extension and the website each keep the previous number for a release. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1];

export const STREAM_NAMES = ['search', 'summary'] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

/** Everything a website may ask for. A new method gets a new name; a released name keeps its meaning. */
export const WEB_METHODS = [
  'favicon', 'focusWorker', 'domainPreference', 'undoDomainPreference', 'prefs.load', 'prefs.save',
  'academicLanguage.load', 'academicLanguage.save', 'openLocal', 'openOptions',
] as const;
export type WebMethod = (typeof WEB_METHODS)[number];
export const isWebMethod = (value: unknown): value is WebMethod => typeof value === 'string' && (WEB_METHODS as readonly string[]).includes(value);

/** What the extension tells the page it can do. The page decides what to show from this list, not from a version number. */
export const WEB_CAPS: readonly string[] = [...WEB_METHODS, 'stream:search', 'stream:summary', 'push:prefs'];

export type ClientMessage =
  | { t: 'hello'; protocols: number[] }
  | { t: 'req'; id: number; method: string; params?: unknown }
  | { t: 'open'; ch: number; name: StreamName }
  | { t: 'msg'; ch: number; data: unknown }
  | { t: 'close'; ch: number };

export type BridgeError = { code: string; message: string };

export type ServerMessage =
  | { t: 'welcome'; protocol: number; ext: string; caps: string[] }
  | { t: 'incompatible'; protocols: number[] }
  /** The extension is set to use its own interface and refuses everything from websites. */
  | { t: 'disabled' }
  /** The extension could not answer the handshake (it is restarting or updating). */
  | { t: 'unavailable' }
  | { t: 'res'; id: number; ok: true; result?: unknown }
  | { t: 'res'; id: number; ok: false; error: BridgeError }
  | { t: 'msg'; ch: number; data: unknown }
  | { t: 'close'; ch: number }
  | { t: 'push'; name: string; data: unknown };

/** The extension's answer to the handshake, before the relay has chosen a protocol number. */
export type HelloReply = { state: 'ok'; ext: string; caps: string[] } | { state: 'disabled' };

const MAX_ID = 2 ** 31 - 1;
const isId = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_ID;

/** A message from the page, or null if it is not exactly one of the known shapes. Anything else is dropped without an answer. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'hello':
      return Array.isArray(m.protocols) && m.protocols.length >= 1 && m.protocols.length <= 8
        && m.protocols.every((p) => Number.isInteger(p) && p >= 1 && p <= 1000)
        ? { t: 'hello', protocols: m.protocols as number[] } : null;
    case 'req':
      return isId(m.id) && typeof m.method === 'string' && m.method.length >= 1 && m.method.length <= 40
        ? { t: 'req', id: m.id, method: m.method, params: m.params } : null;
    case 'open':
      return isId(m.ch) && (STREAM_NAMES as readonly unknown[]).includes(m.name) ? { t: 'open', ch: m.ch, name: m.name as StreamName } : null;
    case 'msg':
      return isId(m.ch) ? { t: 'msg', ch: m.ch, data: m.data } : null;
    case 'close':
      return isId(m.ch) ? { t: 'close', ch: m.ch } : null;
    default:
      return null;
  }
}

/** The highest protocol number both sides know, or null. */
export function chooseProtocol(offered: readonly number[], supported: readonly number[] = SUPPORTED_PROTOCOLS): number | null {
  const common = offered.filter((p) => supported.includes(p));
  return common.length ? Math.max(...common) : null;
}
