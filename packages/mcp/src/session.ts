import { BridgeHub, RelayClient, type BridgeReply, type BridgeRequest } from './bridge';

export interface BridgeSessionOptions {
  port: number;
  extensionId?: string;
  /** Per-request timeout passed to the hub or relay. */
  timeoutMs?: number;
  /** Upper bound for the random delay before retaking the hub, so racing processes spread out. */
  takeoverJitterMs?: number;
}

/**
 * Owns this process's link to the browser. The first process binds the port and becomes the hub;
 * the others relay through it. When the hub process exits, the relays try to bind the port again,
 * so one of them takes over instead of every later request waiting out its timeout.
 */
export class BridgeSession {
  private current: BridgeHub | RelayClient | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly token: string,
    private readonly options: BridgeSessionOptions,
  ) {}

  get role(): 'hub' | 'relay' | 'none' {
    if (this.current instanceof BridgeHub) return 'hub';
    return this.current ? 'relay' : 'none';
  }

  /** Port the hub listens on (differs from the configured one only when that was 0). */
  get port(): number {
    return this.current instanceof BridgeHub ? this.current.port : this.options.port;
  }

  async start(): Promise<void> {
    await this.ensureConnected();
  }

  async request(
    request: BridgeRequest,
    signal?: AbortSignal,
    onProgress?: (reply: BridgeReply) => void,
  ): Promise<BridgeReply> {
    await this.ensureConnected();
    return this.current!.request(request, signal, onProgress);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const current = this.current;
    this.current = null;
    if (current instanceof BridgeHub) await current.close();
    else current?.close();
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP bridge closed'));
    if (this.current && !(this.current instanceof RelayClient && !this.current.isOpen())) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const hub = new BridgeHub(this.token, {
      port: this.options.port,
      extensionId: this.options.extensionId,
      timeoutMs: this.options.timeoutMs,
    });
    try {
      await hub.start();
      this.current = hub;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
    this.current = await RelayClient.connect(this.options.port, this.token, this.options.timeoutMs, () => this.onRelayClosed());
  }

  private onRelayClosed(): void {
    if (this.closed) return;
    this.current = null;
    this.scheduleTakeover(this.options.takeoverJitterMs ?? 400);
  }

  private scheduleTakeover(maxDelayMs: number, attempt = 0): void {
    if (this.closed) return;
    const delay = Math.random() * maxDelayMs + Math.min(attempt, 5) * 1000;
    this.retryTimer = setTimeout(() => {
      this.ensureConnected().catch(() => this.scheduleTakeover(maxDelayMs, attempt + 1));
    }, delay);
    this.retryTimer.unref?.();
  }
}
