import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export const NOT_CONNECTED_MESSAGE = '浏览器插件未连接：请打开 Chrome 并在 Kiwi Search 设置中启用 MCP 桥';
export const PAIRING_MISMATCH_MESSAGE = '配对令牌不匹配，请在 Kiwi Search 设置中填写 MCP 服务生成的 token';

export interface BridgeRequest {
  type: 'search' | 'answer' | 'list_sources';
  query?: string;
  options?: { sources?: string[]; limit?: number; summarize?: boolean };
}

export interface BridgeReply {
  id?: string;
  type: 'result' | 'error' | 'progress' | 'ready';
  result?: unknown;
  error?: string;
  event?: unknown;
}

interface Pending {
  resolve: (reply: BridgeReply) => void;
  reject: (error: Error) => void;
  progress?: (reply: BridgeReply) => void;
  client?: WebSocket;
  clientId?: string;
  timer: ReturnType<typeof setTimeout>;
}

function asText(data: RawData): string {
  return typeof data === 'string' ? data : data.toString();
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function allowedExtensionOrigin(origin: string | undefined, extensionId?: string): boolean {
  if (!origin?.startsWith('chrome-extension://')) return false;
  return !extensionId || origin === `chrome-extension://${extensionId}`;
}

export class BridgeHub {
  private readonly httpServer = createServer();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly pending = new Map<string, Pending>();
  private extension: WebSocket | null = null;
  private started = false;
  port: number;

  constructor(
    private readonly token: string,
    private readonly options: { port: number; extensionId?: string; timeoutMs?: number; host?: string },
  ) {
    this.port = options.port;
    this.httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off('error', onError);
        const address = this.httpServer.address();
        if (address && typeof address === 'object') this.port = address.port;
        this.started = true;
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(this.options.port, this.options.host ?? '127.0.0.1');
    });
  }

  isConnected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }

  async request(
    request: BridgeRequest,
    signal?: AbortSignal,
    onProgress?: (reply: BridgeReply) => void,
  ): Promise<BridgeReply> {
    const socket = this.extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(NOT_CONNECTED_MESSAGE);
    if (signal?.aborted) throw signal.reason ?? new Error('MCP request cancelled');
    const id = randomUUID();
    return new Promise<BridgeReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        socket.send(JSON.stringify({ type: 'cancel', id }));
        reject(new Error('浏览器搜索请求超时（150 秒）'));
      }, this.options.timeoutMs ?? 150000);
      const pending: Pending = { resolve, reject, progress: onProgress, timer: timeout };
      this.pending.set(id, pending);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timeout);
        socket.send(JSON.stringify({ type: 'cancel', id }));
        reject(signal?.reason ?? new Error('MCP request cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const originalResolve = pending.resolve;
      pending.resolve = (reply) => {
        cleanup();
        originalResolve(reply);
      };
      const originalReject = pending.reject;
      pending.reject = (error) => {
        cleanup();
        originalReject(error);
      };
      socket.send(JSON.stringify({ ...request, id }));
    });
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP bridge closed'));
      this.pending.delete(id);
    }
    this.extension?.close();
    this.wss.close();
    if (this.started) await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    this.started = false;
  }

  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/extension' && !allowedExtensionOrigin(request.headers.origin, this.options.extensionId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (path !== '/extension' && path !== '/mcp') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (websocket) => this.wss.emit('connection', websocket, request));
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const extension = path === '/extension';
    let authenticated = false;
    socket.on('message', (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(asText(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!authenticated) {
        if (message.type !== 'hello' || typeof message.token !== 'string' || !constantTimeEqual(message.token, this.token)) {
          socket.close(4001, PAIRING_MISMATCH_MESSAGE);
          return;
        }
        authenticated = true;
        if (extension) {
          this.extension?.close(4002, 'A newer extension connection replaced this one');
          this.extension = socket;
          socket.on('close', () => {
            if (this.extension === socket) {
              this.extension = null;
              this.rejectPendingForExtension();
            }
          });
        }
        socket.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (message.type === 'ping') {
        socket.send('{"type":"pong"}');
        return;
      }
      if (extension) this.routeExtensionMessage(message as unknown as BridgeReply);
      else this.routeRelayMessage(socket, message);
    });
    if (!extension) {
      socket.on('close', () => {
        for (const [id, pending] of this.pending) {
          if (pending.client !== socket) continue;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          this.extension?.send(JSON.stringify({ type: 'cancel', id }));
        }
      });
    }
  }

  private routeExtensionMessage(message: BridgeReply): void {
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'progress') {
      pending.progress?.(message);
      if (pending.client?.readyState === WebSocket.OPEN) pending.client.send(JSON.stringify({ ...message, id: pending.clientId }));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error') {
      const error = new Error(message.error ?? 'Extension request failed');
      if (pending.client?.readyState === WebSocket.OPEN) {
        pending.client.send(JSON.stringify({ id: pending.clientId, type: 'error', error: error.message }));
      }
      pending.reject(error);
      return;
    }
    if (pending.client?.readyState === WebSocket.OPEN) pending.client.send(JSON.stringify({ ...message, id: pending.clientId }));
    pending.resolve(message);
  }

  private routeRelayMessage(client: WebSocket, message: Record<string, unknown>): void {
    const originalId = typeof message.id === 'string' ? message.id : '';
    if (message.type === 'cancel') {
      const routeId = [...this.pending].find(([, pending]) => pending.client === client && pending.clientId === originalId)?.[0];
      if (routeId) {
        const pending = this.pending.get(routeId);
        clearTimeout(pending?.timer);
        this.pending.delete(routeId);
        this.extension?.send(JSON.stringify({ type: 'cancel', id: routeId }));
      }
      return;
    }
    if (!['search', 'answer', 'list_sources'].includes(String(message.type))) return;
    if (!this.isConnected()) {
      client.send(JSON.stringify({ id: originalId, type: 'error', error: NOT_CONNECTED_MESSAGE }));
      return;
    }
    const routeId = randomUUID();
    const timeout = setTimeout(() => {
      this.pending.delete(routeId);
      this.extension?.send(JSON.stringify({ type: 'cancel', id: routeId }));
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: originalId, type: 'error', error: '浏览器搜索请求超时（150 秒）' }));
    }, this.options.timeoutMs ?? 150000);
    this.pending.set(routeId, {
      resolve: () => {},
      reject: () => {},
      timer: timeout,
      client,
      clientId: originalId,
    });
    const { id: _id, ...payload } = message;
    this.extension!.send(JSON.stringify({ ...payload, id: routeId }));
  }

  private rejectPendingForExtension(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = new Error(NOT_CONNECTED_MESSAGE);
      if (pending.client?.readyState === WebSocket.OPEN) pending.client.send(JSON.stringify({ id: pending.clientId, type: 'error', error: error.message }));
      pending.reject(error);
    }
  }
}

export class RelayClient {
  private readonly pending = new Map<string, Pending>();
  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.on('message', (data) => this.receive(JSON.parse(asText(data)) as BridgeReply));
    socket.on('close', () => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(NOT_CONNECTED_MESSAGE));
      }
      this.pending.clear();
    });
  }

  static async connect(port: number, token: string, timeoutMs = 150000): Promise<RelayClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`, { origin: 'http://127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error('MCP relay handshake timed out'));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('error', onError);
        socket.off('close', onClose);
        socket.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = (_code: number, reason: Buffer) => {
        cleanup();
        reject(new Error(reason.toString() || PAIRING_MISMATCH_MESSAGE));
      };
      const onMessage = (data: RawData) => {
        const message = JSON.parse(asText(data)) as { type?: string; error?: string };
        if (message.type === 'ready') {
          cleanup();
          resolve();
        } else if (message.type === 'error') {
          cleanup();
          reject(new Error(message.error ?? PAIRING_MISMATCH_MESSAGE));
        }
      };
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'hello', token }));
        socket.on('message', onMessage);
      });
    });
    return new RelayClient(socket, timeoutMs);
  }

  request(request: BridgeRequest, signal?: AbortSignal, onProgress?: (reply: BridgeReply) => void): Promise<BridgeReply> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('MCP request cancelled'));
    const id = randomUUID();
    return new Promise<BridgeReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.socket.send(JSON.stringify({ type: 'cancel', id }));
        reject(new Error('浏览器搜索请求超时（150 秒）'));
      }, this.timeoutMs);
      const pending: Pending = { resolve, reject, progress: onProgress, timer };
      this.pending.set(id, pending);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.socket.send(JSON.stringify({ type: 'cancel', id }));
        reject(signal?.reason ?? new Error('MCP request cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const originalResolve = pending.resolve;
      pending.resolve = (reply) => {
        cleanup();
        originalResolve(reply);
      };
      const originalReject = pending.reject;
      pending.reject = (error) => {
        cleanup();
        originalReject(error);
      };
      this.socket.send(JSON.stringify({ ...request, id }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private receive(message: BridgeReply): void {
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'progress') {
      pending.progress?.(message);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error') pending.reject(new Error(message.error ?? 'Extension request failed'));
    else pending.resolve(message);
  }
}
