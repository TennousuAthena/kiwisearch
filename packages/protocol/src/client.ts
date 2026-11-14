import { SUPPORTED_PROTOCOLS, type BridgeError, type ServerMessage, type StreamName } from './bridge';
import type { PortLike } from './relay';

export type HelloOutcome =
  | { state: 'ok'; protocol: number; ext: string; caps: string[] }
  | { state: 'incompatible'; protocols: number[] }
  | { state: 'disabled' }
  | { state: 'unavailable' };

/** A stream to the extension, shaped like a `runtime.Port` so the interface's session controller can use it unchanged. */
export interface ClientStream {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export class BridgeRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeRequestError';
  }
}

export interface BridgeClient {
  /** Offers this build's protocol numbers. Resolves `unavailable` if nothing answers in time. */
  hello(timeoutMs?: number): Promise<HelloOutcome>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  connect(name: StreamName): ClientStream;
  onPush(listener: (name: string, data: unknown) => void): void;
  close(): void;
}

const isServerMessage = (value: unknown): value is ServerMessage => !!value && typeof value === 'object' && typeof (value as { t?: unknown }).t === 'string';

/** The page's half of the bridge: turns the private port into promises and streams. */
export function createBridgeClient(port: PortLike): BridgeClient {
  let nextId = 1;
  let nextChannel = 1;
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const streams = new Map<number, { message: Array<(m: unknown) => void>; disconnect: Array<() => void> }>();
  const pushListeners: Array<(name: string, data: unknown) => void> = [];
  let helloWaiter: ((outcome: HelloOutcome) => void) | null = null;

  const failAll = (error: Error) => {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); pending.delete(id); }
    for (const [ch, entry] of streams) { streams.delete(ch); entry.disconnect.forEach((listener) => listener()); }
  };

  port.onmessage = (event) => {
    const m: unknown = event?.data;
    if (!isServerMessage(m)) return;
    switch (m.t) {
      case 'welcome': helloWaiter?.({ state: 'ok', protocol: m.protocol, ext: m.ext, caps: m.caps }); helloWaiter = null; break;
      case 'incompatible': helloWaiter?.({ state: 'incompatible', protocols: m.protocols }); helloWaiter = null; break;
      case 'disabled': helloWaiter?.({ state: 'disabled' }); helloWaiter = null; break;
      case 'unavailable': helloWaiter?.({ state: 'unavailable' }); helloWaiter = null; break;
      case 'res': {
        const entry = pending.get(m.id);
        if (!entry) break;
        pending.delete(m.id);
        clearTimeout(entry.timer);
        if (m.ok) entry.resolve(m.result);
        else { const error = m.error as BridgeError; entry.reject(new BridgeRequestError(error.code, error.message)); }
        break;
      }
      case 'msg': streams.get(m.ch)?.message.forEach((listener) => listener(m.data)); break;
      case 'close': {
        const entry = streams.get(m.ch);
        if (entry) { streams.delete(m.ch); entry.disconnect.forEach((listener) => listener()); }
        break;
      }
      case 'push': pushListeners.forEach((listener) => listener(m.name, m.data)); break;
      default: break; // a message type from a newer extension: ignored, as the protocol rules say
    }
  };

  return {
    hello(timeoutMs = 3000) {
      return new Promise<HelloOutcome>((resolve) => {
        const timer = setTimeout(() => { helloWaiter = null; resolve({ state: 'unavailable' }); }, timeoutMs);
        helloWaiter = (outcome) => { clearTimeout(timer); resolve(outcome); };
        port.postMessage({ t: 'hello', protocols: [...SUPPORTED_PROTOCOLS] });
      });
    },
    request<T>(method: string, params?: unknown, timeoutMs = 30_000) {
      if (closed) return Promise.reject(new BridgeRequestError('closed', 'The connection to the extension is closed'));
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new BridgeRequestError('timeout', `${method} did not answer`)); }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        port.postMessage({ t: 'req', id, method, params });
      });
    },
    connect(name) {
      const ch = nextChannel++;
      const entry = { message: [] as Array<(m: unknown) => void>, disconnect: [] as Array<() => void> };
      streams.set(ch, entry);
      port.postMessage({ t: 'open', ch, name });
      return {
        postMessage: (message) => { if (streams.has(ch)) port.postMessage({ t: 'msg', ch, data: message }); },
        disconnect: () => { if (streams.delete(ch)) port.postMessage({ t: 'close', ch }); },
        onMessage: { addListener: (listener) => { entry.message.push(listener); } },
        onDisconnect: { addListener: (listener) => { entry.disconnect.push(listener); } },
      };
    },
    onPush: (listener) => { pushListeners.push(listener); },
    close() {
      if (closed) return;
      closed = true;
      port.onmessage = null;
      failAll(new BridgeRequestError('closed', 'The connection to the extension is closed'));
      try { port.close?.(); } catch { /* already closed */ }
    },
  };
}
