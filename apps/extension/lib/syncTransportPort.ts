export interface ReconnectingPort {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
}

interface ReconnectingPortOptions<TPort extends ReconnectingPort> {
  connect: () => TPort;
  onMessage: (message: unknown) => void;
  onReconnect: (port: TPort) => void;
  maxBufferedMessages?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class ReconnectingPortClient<TPort extends ReconnectingPort> {
  private port: TPort | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private buffer: unknown[] = [];
  private readonly maxBufferedMessages: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly options: ReconnectingPortOptions<TPort>) {
    this.maxBufferedMessages = options.maxBufferedMessages ?? 256;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.port = null;
  }

  postMessage(message: unknown): void {
    if (this.port) {
      try {
        this.port.postMessage(message);
        return;
      } catch {
        this.disconnect(this.port);
      }
    }
    this.bufferMessage(message);
  }

  private connect(): void {
    if (!this.running || this.port) return;
    let port: TPort;
    try {
      port = this.options.connect();
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => {
      if (this.port !== port) return;
      this.reconnectAttempts = 0;
      this.options.onMessage(message);
    });
    port.onDisconnect.addListener(() => this.disconnect(port));
    while (this.port === port && this.buffer.length) {
      const message = this.buffer[0];
      try {
        port.postMessage(message);
        this.buffer.shift();
      } catch {
        this.disconnect(port);
        break;
      }
    }
    if (this.port === port) this.options.onReconnect(port);
  }

  private disconnect(port: TPort): void {
    if (this.port !== port) return;
    this.port = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(this.baseDelayMs * 2 ** this.reconnectAttempts, this.maxDelayMs);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private bufferMessage(message: unknown): void {
    if (!this.maxBufferedMessages) return;
    if (this.buffer.length >= this.maxBufferedMessages) this.buffer.shift();
    this.buffer.push(message);
  }
}
