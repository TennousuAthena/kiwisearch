import {
  concatBytes,
  fromBase64Url,
  toArrayBufferView,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './encoding';
import type { GroupKeys } from './crypto';
import { SYNC_PROTOCOL_VERSION } from './crypto';

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
  groupKeys: Pick<GroupKeys, 'signalKey' | 'groupHint'>,
  payload: ConnectionCodePayload,
): Promise<string> {
  const kindByte = payload.kind === 'offer' ? KIND_OFFER : KIND_ANSWER;
  const header = new Uint8Array(new ArrayBuffer(6));
  header[0] = SYNC_PROTOCOL_VERSION;
  header[1] = kindByte;
  header.set(groupKeys.groupHint, 2);

  const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  crypto.getRandomValues(nonce);

  const body = utf8Encode(
    JSON.stringify({
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
  groupKeys: Pick<GroupKeys, 'signalKey' | 'groupHint'>,
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
  for (let i = 0; i < 4; i++) {
    if (bytes[2 + i] !== groupKeys.groupHint[i]) {
      throw new Error('Connection code does not match this sync group');
    }
  }
  const header = toArrayBufferView(bytes.subarray(0, 6));
  const nonce = toArrayBufferView(bytes.subarray(6, 6 + NONCE_BYTES));
  const ciphertext = toArrayBufferView(bytes.subarray(6 + NONCE_BYTES));

  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, groupKeys.signalKey, ciphertext),
  );
  const parsed = JSON.parse(utf8Decode(plain)) as {
    d: string;
    t: number;
    u: string;
    p: string;
    f: string;
    c: [number, string, number, number][];
  };
  if (maxAgeMs > 0 && Math.abs(nowMs - parsed.t) > maxAgeMs) {
    throw new Error('Connection code has expired');
  }
  return {
    kind,
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
