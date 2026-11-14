import { chooseProtocol, parseClientMessage, SUPPORTED_PROTOCOLS, type BridgeError, type HelloReply, type ServerMessage, type StreamName } from './bridge';

/** The page's end of a `MessageChannel` (or anything shaped like one). */
export interface PortLike {
  postMessage(message: unknown): void;
  // `any` on purpose: a real MessagePort hands over a MessageEvent, a test double only needs `data`.
  onmessage: ((event: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  close?(): void;
}

/** A `runtime.Port` as far as the relay uses it. */
export interface StreamPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface RelayLimits {
  /** Streams one page may hold open at once (a search and its summary, plus one spare). */
  maxStreams: number;
  /** Requests waiting for an answer at once. */
  maxInFlight: number;
  /** Malformed or out-of-turn messages before the relay gives up on the page. */
  maxViolations: number;
}
export const DEFAULT_RELAY_LIMITS: RelayLimits = { maxStreams: 4, maxInFlight: 16, maxViolations: 50 };

export interface RelayDeps {
  /** Asks the service worker whether the page may talk to the extension. */
  hello(): Promise<HelloReply>;
  /** One request to the service worker. A rejection becomes an error answer; an object with `code` and `message` keeps them. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Opens a stream to the service worker (a `runtime.connect`). */
  openStream(name: StreamName): StreamPort;
  limits?: Partial<RelayLimits>;
}

export interface Relay {
  /** Sends something to the page on its own (a changed preference). Ignored until the handshake has succeeded. */
  push(name: string, data: unknown): void;
  close(): void;
}

function toError(reason: unknown): BridgeError {
  if (reason && typeof reason === 'object' && typeof (reason as BridgeError).code === 'string') {
    const { code, message } = reason as BridgeError;
    return { code: code.slice(0, 40), message: String(message ?? '').slice(0, 200) };
  }
  return { code: 'failed', message: (reason instanceof Error ? reason.message : String(reason)).slice(0, 200) };
}

/**
 * The content script's half of the bridge. It sits between the page's private port and the service worker, and it is the only
 * place a page's message becomes an extension message, so it checks every message's shape and keeps counts: a page that sends junk,
 * or opens more than it may, gets cut off. What a request may ask for is checked again in the service worker.
 */
export function createBridgeRelay(port: PortLike, deps: RelayDeps): Relay {
  const limits = { ...DEFAULT_RELAY_LIMITS, ...deps.limits };
  const streams = new Map<number, StreamPort>();
  let ready = false;
  let closed = false;
  let violations = 0;
  let inFlight = 0;

  const send = (message: ServerMessage) => {
    if (closed) return;
    try { port.postMessage(message); } catch { /* the page went away */ }
  };
  const dropStream = (ch: number, notify: boolean) => {
    const stream = streams.get(ch);
    if (!stream) return;
    streams.delete(ch);
    try { stream.disconnect(); } catch { /* already gone */ }
    if (notify) send({ t: 'close', ch });
  };
  const close = () => {
    if (closed) return;
    for (const ch of [...streams.keys()]) dropStream(ch, false);
    closed = true;
    port.onmessage = null;
    try { port.close?.(); } catch { /* already closed */ }
  };
  const violation = () => { if (++violations > limits.maxViolations) close(); };

  port.onmessage = (event) => {
    if (closed) return;
    const m = parseClientMessage(event?.data);
    if (!m) return violation();
    switch (m.t) {
      case 'hello': {
        const protocol = chooseProtocol(m.protocols);
        if (protocol === null) { send({ t: 'incompatible', protocols: [...SUPPORTED_PROTOCOLS] }); return; }
        deps.hello().then((reply) => {
          if (reply.state === 'disabled') { ready = false; send({ t: 'disabled' }); return; }
          ready = true;
          send({ t: 'welcome', protocol, ext: reply.ext, caps: reply.caps });
        }, () => { ready = false; send({ t: 'unavailable' }); });
        return;
      }
      case 'req': {
        // `openLocal` works without a handshake: it is how a page sends the user to the extension's own interface when the two sides
        // cannot agree on a protocol number. The service worker still decides whether to do it.
        if (!ready && m.method !== 'openLocal') { send({ t: 'res', id: m.id, ok: false, error: { code: 'not_ready', message: 'No handshake yet' } }); return violation(); }
        if (inFlight >= limits.maxInFlight) { send({ t: 'res', id: m.id, ok: false, error: { code: 'busy', message: 'Too many requests at once' } }); return; }
        inFlight++;
        let outcome: Promise<unknown>;
        try { outcome = Promise.resolve(deps.request(m.method, m.params)); } catch (error) { outcome = Promise.reject(error); }
        outcome.then(
          (result) => send({ t: 'res', id: m.id, ok: true, result }),
          (reason) => send({ t: 'res', id: m.id, ok: false, error: toError(reason) }),
        ).finally(() => { inFlight--; });
        return;
      }
      case 'open': {
        if (!ready || streams.has(m.ch) || streams.size >= limits.maxStreams) { send({ t: 'close', ch: m.ch }); return violation(); }
        let stream: StreamPort;
        try { stream = deps.openStream(m.name); } catch { send({ t: 'close', ch: m.ch }); return; }
        streams.set(m.ch, stream);
        stream.onMessage.addListener((data) => { if (streams.get(m.ch) === stream) send({ t: 'msg', ch: m.ch, data }); });
        stream.onDisconnect.addListener(() => { if (streams.get(m.ch) === stream) { streams.delete(m.ch); send({ t: 'close', ch: m.ch }); } });
        return;
      }
      case 'msg': {
        const stream = streams.get(m.ch);
        if (!stream) return violation();
        try { stream.postMessage(m.data); } catch { dropStream(m.ch, true); }
        return;
      }
      case 'close':
        dropStream(m.ch, false);
        return;
    }
  };

  return {
    push: (name, data) => { if (ready) send({ t: 'push', name, data }); },
    close,
  };
}
