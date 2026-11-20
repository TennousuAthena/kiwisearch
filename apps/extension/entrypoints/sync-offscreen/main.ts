import { browser } from 'wxt/browser';
import { SyncTransportCore, type TransportConfig, type TransportEvent } from '../../lib/syncTransportCore';
import { ReconnectingPortClient } from '../../lib/syncTransportPort';

type TransportCommand =
  | { id?: string; cmd: 'start'; config: TransportConfig }
  | { id?: string; cmd: 'stop' }
  | { id?: string; cmd: 'send'; peerId: string; payload: string }
  | { id?: string; cmd: 'broadcast'; payload: string }
  | { id: string; cmd: 'create-offer-code' }
  | { id: string; cmd: 'create-answer-code'; offerCode: string }
  | { id: string; cmd: 'accept-answer-code'; answerCode: string };

let core: SyncTransportCore;
const portClient = new ReconnectingPortClient<Browser.runtime.Port>({
  connect: () => browser.runtime.connect({ name: 'kiwi-sync-transport' }),
  onMessage: handleCommand,
  onReconnect: () => {
    portClient.postMessage({ kind: 'event', event: core.getReconnectSnapshot() });
  },
});

core = new SyncTransportCore((event: TransportEvent) => {
  portClient.postMessage({ kind: 'event', event });
});

function handleCommand(raw: unknown): void {
  const msg = raw as TransportCommand;
  if (!msg || typeof msg !== 'object') return;
  const reply = (ok: boolean, data?: Record<string, unknown>) => {
    if (!msg.id) return;
    portClient.postMessage({ kind: 'reply', id: msg.id, ok, ...data });
  };

  if (msg.cmd === 'start') {
    void core.start(msg.config).then(
      () => reply(true),
      (err) => reply(false, { error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (msg.cmd === 'stop') {
    core.stop();
    reply(true);
  } else if (msg.cmd === 'send') {
    void core.sendToPeer(msg.peerId, msg.payload).then(
      (sent) => reply(true, { sent }),
      (err) => reply(false, { error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (msg.cmd === 'broadcast') {
    void core.broadcast(msg.payload).then(
      () => reply(true),
      (err) => reply(false, { error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (msg.cmd === 'create-offer-code') {
    void core.createOfferCode().then(
      (code) => reply(true, { code }),
      (err) => reply(false, { error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (msg.cmd === 'create-answer-code') {
    void core.createAnswerCode(msg.offerCode).then(
      (code) => reply(true, { code }),
      (err) => reply(false, { error: err instanceof Error ? err.message : String(err) }),
    );
  } else if (msg.cmd === 'accept-answer-code') {
    void core.acceptAnswerCode(msg.answerCode).then(
      () => reply(true),
      (err) => reply(false, { error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

portClient.start();
