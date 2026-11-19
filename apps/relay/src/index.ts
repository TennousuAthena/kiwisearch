/**
 * Kiwi's sync relay (docs/internals/device-sync.md). Devices that hold the same recovery phrase meet in a topic whose id they derive
 * from it; this Worker hands each topic's WebSockets to one Durable Object, which forwards every binary frame to the other sockets of
 * that topic. Frames are encrypted, authenticated and padded on the devices with keys the relay never has. The relay does not parse,
 * log or store them, and holds nothing for a device that is not connected: two devices sync only while both are online.
 */

import { LIMITS, PROTOCOL } from './limits';

const TOPIC_PATH = /^\/v1\/([A-Za-z0-9_-]{22,64})$/;
/**
 * Only extension pages may open a socket: a web page, the Kiwi website included, has no business here. This is hardening, not
 * authentication: a client outside a browser can omit or forge the header. Security rests on the devices' encryption.
 */
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[^/]+$/;

export interface Env {
  TOPIC: DurableObjectNamespace;
}

interface Rate {
  windowStart: number;
  count: number;
}

const plain = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const isUpgrade = (request: Request) => request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
/** Codes a peer may receive but nobody may send. */
const RESERVED_CLOSE = new Set([1005, 1006, 1015]);

export class Topic {
  constructor(private readonly ctx: DurableObjectState) {
    // A text "ping" is answered by the runtime itself, so keepalives neither wake the object nor count as frames.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  fetch(request: Request): Response {
    if (!isUpgrade(request)) return plain('expected a WebSocket upgrade', 426);
    if (this.ctx.getWebSockets().length >= LIMITS.socketsPerTopic) return plain('topic full', 429);
    const { 0: client, 1: server } = new WebSocketPair();
    // The Hibernation API: the object can leave memory while the sockets stay open, so a quiet topic costs no duration.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ windowStart: Date.now(), count: 0 } satisfies Rate);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string') return ws.close(1003, 'binary frames only');
    if (message.byteLength > LIMITS.frameBytes) return ws.close(1009, `frames of at most ${LIMITS.frameBytes} bytes`);
    // The attachment lives with the socket (and survives hibernation); it is not the object's storage.
    const rate = ws.deserializeAttachment() as Rate;
    const now = Date.now();
    if (now - rate.windowStart >= LIMITS.windowMs) {
      rate.windowStart = now;
      rate.count = 0;
    }
    if (++rate.count > LIMITS.framesPerWindow) return ws.close(1008, 'too many frames');
    ws.serializeAttachment(rate);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(message);
      } catch {
        // The peer is closing; it gets nothing more.
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(RESERVED_CLOSE.has(code) ? 1000 : code, 'bye');
    } catch {
      // Already closed.
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'error');
    } catch {
      // Already closed.
    }
  }
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return plain('method not allowed', 405);
      return Response.json({ service: 'kiwi-sync-relay', protocol: PROTOCOL, limits: LIMITS }, { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
    }
    const match = TOPIC_PATH.exec(url.pathname);
    if (!match) return plain('not found', 404);
    const origin = request.headers.get('Origin');
    if (origin && !EXTENSION_ORIGIN.test(origin)) return plain('only extension pages may connect', 403);
    if (!isUpgrade(request)) return plain('expected a WebSocket upgrade', 426);
    return env.TOPIC.get(env.TOPIC.idFromName(match[1])).fetch(request);
  },
} satisfies ExportedHandler<Env>;
