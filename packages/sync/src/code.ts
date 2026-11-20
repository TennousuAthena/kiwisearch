import {
  concatBytes,
  fromBase64Url,
  toArrayBufferView,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './encoding';
import type { GroupKeys } from './crypto';
import { deriveGroupHint, SYNC_PROTOCOL_VERSION, utcDayString } from './crypto';

export const CONNECTION_CODE_PREFIX = 'kiwi1-';

export type ConnectionCodeKind = 'offer' | 'answer';

export interface CompactIceCandidate {
  /** 'host' | 'srflx' */
  type: 'host' | 'srflx';
  /** IPv4, IPv6, or mDNS (.local) address */
  address: string;
  port: number;
  protocol?: 'udp' | 'tcp';
}

export interface ConnectionCodePayload {
  kind: ConnectionCodeKind;
  epoch: number;
  deviceId: string;
  timestampMs: number;
  ufrag: string;
  pwd: string;
  /** SHA-256 DTLS fingerprint (colon-separated hex or raw 32-byte hex) */
  fingerprint: string;
  candidates: CompactIceCandidate[];
}

const KIND_OFFER = 1;
const KIND_ANSWER = 2;
const NONCE_BYTES = 12;

export async function encodeConnectionCode(
  groupKeys: Pick<GroupKeys, 'signalKey' | 'topicKey'>,
  payload: ConnectionCodePayload,
  nowMs = Date.now(),
): Promise<string> {
  const kindByte = payload.kind === 'offer' ? KIND_OFFER : KIND_ANSWER;
  const header = new Uint8Array(new ArrayBuffer(6));
  header[0] = SYNC_PROTOCOL_VERSION;
  header[1] = kindByte;
  header.set(await deriveGroupHint(groupKeys.topicKey, utcDayString(nowMs)), 2);

  const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  crypto.getRandomValues(nonce);

  const body = utf8Encode(
    JSON.stringify({
      e: payload.epoch,
      d: payload.deviceId,
      t: payload.timestampMs,
      u: payload.ufrag,
      p: payload.pwd,
      f: payload.fingerprint,
      c: payload.candidates.map((c) => [c.type === 'srflx' ? 1 : 0, c.address, c.port, c.protocol === 'tcp' ? 1 : 0]),
    }),
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, groupKeys.signalKey, body),
  );
  return CONNECTION_CODE_PREFIX + toBase64Url(concatBytes(header, nonce, ciphertext));
}

export async function decodeConnectionCode(
  groupKeys: Pick<GroupKeys, 'signalKey' | 'topicKey'>,
  code: string,
  maxAgeMs = 10 * 60 * 1000,
  nowMs = Date.now(),
): Promise<ConnectionCodePayload> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CONNECTION_CODE_PREFIX)) {
    throw new Error(`Connection code must start with "${CONNECTION_CODE_PREFIX}"`);
  }
  const bytes = fromBase64Url(trimmed.slice(CONNECTION_CODE_PREFIX.length));
  if (bytes.byteLength < 6 + NONCE_BYTES + 16) {
    throw new Error('Connection code is too short');
  }
  if (bytes[0] !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Unsupported connection code version: ${bytes[0]}`);
  }
  const kindByte = bytes[1];
  const kind: ConnectionCodeKind = kindByte === KIND_OFFER ? 'offer' : kindByte === KIND_ANSWER ? 'answer' : (() => {
    throw new Error(`Unknown connection code kind: ${kindByte}`);
  })();
  const today = utcDayString(nowMs);
  const date = new Date(`${today}T00:00:00.000Z`);
  const validHints = await Promise.all([-1, 0, 1].map((offset) => {
    const adjacentDay = new Date(date.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    return deriveGroupHint(groupKeys.topicKey, adjacentDay);
  }));
  if (!validHints.some((hint) => hint.every((byte, index) => bytes[2 + index] === byte))) {
    throw new Error('Connection code does not match this sync group');
  }
  const header = toArrayBufferView(bytes.subarray(0, 6));
  const nonce = toArrayBufferView(bytes.subarray(6, 6 + NONCE_BYTES));
  const ciphertext = toArrayBufferView(bytes.subarray(6 + NONCE_BYTES));

  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, groupKeys.signalKey, ciphertext),
  );
  const parsed = JSON.parse(utf8Decode(plain)) as {
    e: number;
    d: string;
    t: number;
    u: string;
    p: string;
    f: string;
    c: [number, string, number, number][];
  };
  if (!Number.isInteger(parsed.e) || parsed.e < 1) {
    throw new Error('Connection code has an invalid epoch');
  }
  if (maxAgeMs > 0 && Math.abs(nowMs - parsed.t) > maxAgeMs) {
    throw new Error('Connection code has expired');
  }
  return {
    kind,
    epoch: parsed.e,
    deviceId: parsed.d,
    timestampMs: parsed.t,
    ufrag: parsed.u,
    pwd: parsed.p,
    fingerprint: parsed.f,
    candidates: parsed.c.map(([typeFlag, address, port, protoFlag]) => ({
      type: typeFlag === 1 ? 'srflx' : 'host',
      address,
      port,
      protocol: protoFlag === 1 ? 'tcp' : 'udp',
    })),
  };
}
