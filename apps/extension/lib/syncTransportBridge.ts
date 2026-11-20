import { browser } from 'wxt/browser';
import { SyncTransportCore, type TransportConfig, type TransportEvent } from './syncTransportCore';

export interface SyncTransport {
  start(config: TransportConfig): Promise<void>;
  stop(): Promise<void>;
  sendToPeer(peerId: string, payload: string, epoch?: number): Promise<boolean>;
  broadcast(payload: string): Promise<void>;
  createOfferCode(): Promise<string>;
  createAnswerCode(offerCode: string): Promise<string>;
  acceptAnswerCode(answerCode: string): Promise<void>;
  attachOffscreenPort(port: Browser.runtime.Port): void;
}

interface PendingReply {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

const OFFSCREEN_PATH = 'sync-offscreen.html';

/**
 * Dual-browser sync transport bridge:
 * - On Chrome/Edge MV3 (service worker without RTCPeerConnection), delegates WebRTC + relay WebSocket
 *   to the `sync-offscreen.html` offscreen document over a `runtime.Port`.
 * - On Firefox (background page with native RTCPeerConnection), runs `SyncTransportCore` directly.
 */
export class ExtensionSyncTransport implements SyncTransport {
  private directCore: SyncTransportCore | null = null;
  private offscreenPort: Browser.runtime.Port | null = null;
  private portWaiters: Array<() => void> = [];
  private pendingReplies = new Map<string, PendingReply>();
  private lastConfig: TransportConfig | null = null;

  constructor(private readonly onEvent: (event: TransportEvent) => void) {}

  private useOffscreen(): boolean {
    const chromeApi = (globalThis as { chrome?: { offscreen?: { createDocument?: unknown } } }).chrome;
    return typeof RTCPeerConnection === 'undefined' && typeof chromeApi?.offscreen?.createDocument === 'function';
  }

  attachOffscreenPort(port: Browser.runtime.Port): void {
    this.offscreenPort = port;
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as { kind?: string; event?: TransportEvent; id?: string; ok?: boolean; error?: string };
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'event' && msg.event) {
        this.onEvent(msg.event);
      } else if (msg.kind === 'reply' && msg.id) {
        const pending = this.pendingReplies.get(msg.id);
        if (pending) {
          this.pendingReplies.delete(msg.id);
          if (msg.ok) pending.resolve(msg as Record<string, unknown>);
          else pending.reject(new Error(msg.error || 'Transport command failed'));
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.offscreenPort !== port) return;
      this.offscreenPort = null;
      for (const pending of this.pendingReplies.values()) {
        pending.reject(new Error('Offscreen transport disconnected'));
      }
      this.pendingReplies.clear();
    });
    const waiters = this.portWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  private async ensureOffscreenPort(): Promise<Browser.runtime.Port> {
    if (this.offscreenPort) return this.offscreenPort;

    const chromeApi = (globalThis as {
      chrome?: {
        offscreen?: {
          createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
          closeDocument(): Promise<void>;
          hasDocument?: () => Promise<boolean>;
        };
      };
    }).chrome;
    if (!chromeApi?.offscreen?.createDocument) {
      throw new Error('Offscreen API unavailable');
    }

    const url = browser.runtime.getURL(`/${OFFSCREEN_PATH}` as never);
    let alreadyOpen = false;
    try {
      const contexts = await (browser.runtime as unknown as {
        getContexts?: (filter: { contextTypes: string[]; documentUrls: string[] }) => Promise<unknown[]>;
      }).getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
      alreadyOpen = Array.isArray(contexts) && contexts.length > 0;
    } catch {
      alreadyOpen = (await chromeApi.offscreen.hasDocument?.().catch(() => false)) ?? false;
    }

    if (!alreadyOpen) {
      try {
        await chromeApi.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['WEB_RTC'],
          justification: 'Peer-to-peer WebRTC data channels and encrypted relay signaling for Kiwi device sync',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/single offscreen document/i.test(msg)) throw err;
      }
    }

    if (this.offscreenPort) return this.offscreenPort;

    return new Promise<Browser.runtime.Port>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for sync offscreen document'));
      }, 8_000);
      this.portWaiters.push(() => {
        clearTimeout(timer);
        if (this.offscreenPort) resolve(this.offscreenPort);
        else reject(new Error('Sync offscreen port unavailable'));
      });
    });
  }

  private async sendOffscreenCommand(cmd: Record<string, unknown>, expectReply = true): Promise<Record<string, unknown>> {
    const port = await this.ensureOffscreenPort();
    if (!expectReply) {
      port.postMessage(cmd);
      return {};
    }
    const id = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(id);
        reject(new Error(`Sync transport command ${String(cmd.cmd)} timed out`));
      }, 15_000);
      this.pendingReplies.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      port.postMessage({ ...cmd, id });
    });
  }

  async start(config: TransportConfig): Promise<void> {
    this.lastConfig = config;
    if (this.useOffscreen()) {
      await this.sendOffscreenCommand({ cmd: 'start', config });
      return;
    }
    if (!this.directCore) this.directCore = new SyncTransportCore(this.onEvent);
    await this.directCore.start(config);
  }

  async stop(): Promise<void> {
    this.lastConfig = null;
    if (this.useOffscreen()) {
      if (this.offscreenPort) {
        await this.sendOffscreenCommand({ cmd: 'stop' }).catch(() => {});
      }
      const chromeApi = (globalThis as { chrome?: { offscreen?: { closeDocument?: () => Promise<void> } } }).chrome;
      await chromeApi?.offscreen?.closeDocument?.().catch(() => {});
      return;
    }
    this.directCore?.stop();
  }

  async sendToPeer(peerId: string, payload: string, epoch?: number): Promise<boolean> {
    if (this.useOffscreen()) {
      if (!this.offscreenPort) return false;
      const res = await this.sendOffscreenCommand({ cmd: 'send', peerId, payload, epoch });
      return Boolean(res.sent);
    }
    if (!this.directCore) return false;
    return this.directCore.sendToPeer(peerId, payload, epoch);
  }

  async broadcast(payload: string): Promise<void> {
    if (this.useOffscreen()) {
      if (!this.offscreenPort) return;
      await this.sendOffscreenCommand({ cmd: 'broadcast', payload });
      return;
    }
    await this.directCore?.broadcast(payload);
  }

  async createOfferCode(): Promise<string> {
    if (this.useOffscreen()) {
      const res = await this.sendOffscreenCommand({ cmd: 'create-offer-code' });
      return String(res.code ?? '');
    }
    if (!this.directCore) {
      this.directCore = new SyncTransportCore(this.onEvent);
      if (this.lastConfig) await this.directCore.start(this.lastConfig);
    }
    return this.directCore.createOfferCode();
  }

  async createAnswerCode(offerCode: string): Promise<string> {
    if (this.useOffscreen()) {
      const res = await this.sendOffscreenCommand({ cmd: 'create-answer-code', offerCode });
      return String(res.code ?? '');
    }
    if (!this.directCore) {
      this.directCore = new SyncTransportCore(this.onEvent);
      if (this.lastConfig) await this.directCore.start(this.lastConfig);
    }
    return this.directCore.createAnswerCode(offerCode);
  }

  async acceptAnswerCode(answerCode: string): Promise<void> {
    if (this.useOffscreen()) {
      await this.sendOffscreenCommand({ cmd: 'accept-answer-code', answerCode });
      return;
    }
    if (!this.directCore) throw new Error('Sync transport not started');
    await this.directCore.acceptAnswerCode(answerCode);
  }
}
