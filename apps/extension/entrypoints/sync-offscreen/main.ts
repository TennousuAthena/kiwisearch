import { browser } from 'wxt/browser';
import { SyncTransportCore, type TransportConfig, type TransportEvent } from '../../lib/syncTransportCore';

type TransportCommand =
  | { id?: string; cmd: 'start'; config: TransportConfig }
  | { id?: string; cmd: 'stop' }
  | { id?: string; cmd: 'send'; peerId: string; payload: string }
  | { id?: string; cmd: 'broadcast'; payload: string }
  | { id: string; cmd: 'create-offer-code' }
  | { id: string; cmd: 'create-answer-code'; offerCode: string }
  | { id: string; cmd: 'accept-answer-code'; answerCode: string };

const port = browser.runtime.connect({ name: 'kiwi-sync-transport' });

const core = new SyncTransportCore((event: TransportEvent) => {
  try {
    port.postMessage({ kind: 'event', event });
  } catch {
    // port closed
  }
});

port.onMessage.addListener((raw: unknown) => {
  const msg = raw as TransportCommand;
  if (!msg || typeof msg !== 'object') return;
  const reply = (ok: boolean, data?: Record<string, unknown>) => {
    if (!msg.id) return;
    try {
      port.postMessage({ kind: 'reply', id: msg.id, ok, ...data });
    } catch {
      // ignore
    }
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
});

port.onDisconnect.addListener(() => {
  core.stop();
});
