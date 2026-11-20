import {
  concatBytes,
  fromBase64Url,
  toArrayBufferView,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './encoding';

export const SYNC_PROTOCOL_VERSION = 1;
export const MAX_RELAY_FRAME_BYTES = 16_384;
export const RELAY_FRAME_BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384] as const;

const HKDF_SALT = utf8Encode('kiwi-sync-v1');
const NONCE_BYTES = 12;
const FRAME_HEADER_BYTES = 1 + 4 + NONCE_BYTES; // version(1) + groupHint(4) + nonce(12)
const AES_GCM_TAG_BYTES = 16;

export interface GroupKeys {
  epoch: number;
  groupHint: Uint8Array<ArrayBuffer>;
  topicKey: CryptoKey;
  signalKey: CryptoKey;
  recordKey: CryptoKey;
  memberKey: CryptoKey;
}

export interface DeviceKeys {
  deviceId: string;
  signing: CryptoKeyPair;
  agreement: CryptoKeyPair;
  signingPublicRaw: Uint8Array<ArrayBuffer>;
  agreementPublicRaw: Uint8Array<ArrayBuffer>;
}

export interface SerializedDevicePublicKeys {
  deviceId: string;
  signingPublic: string;
  agreementPublic: string;
}

export interface WrappedEpochSecret {
  epoch: number;
  senderDeviceId: string;
  senderAgreementPublic: string;
  recipientDeviceId: string;
  nonce: string;
  ciphertext: string;
}

export async function importGroupSecret(entropy: Uint8Array): Promise<CryptoKey> {
  if (entropy.byteLength !== 32) {
    throw new Error(`Expected 32-byte group entropy, got ${entropy.byteLength}`);
  }
  return crypto.subtle.importKey('raw', toArrayBufferView(entropy), 'HKDF', false, ['deriveKey', 'deriveBits']);
}

export async function deriveGroupKeys(groupSecret: CryptoKey, epoch = 1): Promise<GroupKeys> {
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error(`Invalid epoch: ${epoch}`);
  const prefix = `kiwi-sync/v1/epoch/${epoch}/`;

  const [hintBits, topicKey, signalKey, recordKey, memberKey] = await Promise.all([
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8Encode(prefix + 'hint') },
      groupSecret,
      32,
    ),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8Encode(prefix + 'topic') },
      groupSecret,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    ),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8Encode(prefix + 'signal') },
      groupSecret,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8Encode(prefix + 'record') },
      groupSecret,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8Encode(prefix + 'member') },
      groupSecret,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    ),
  ]);

  return {
    epoch,
    groupHint: new Uint8Array(hintBits),
    topicKey,
    signalKey,
    recordKey,
    memberKey,
  };
}

export function utcDayString(now: Date | number = Date.now()): string {
  const date = typeof now === 'number' ? new Date(now) : now;
  return date.toISOString().slice(0, 10);
}

/**
 * Derives the daily rotating relay topic ID (43 base64url chars, matching apps/relay's /v1/:topic).
 */
export async function deriveTopicId(topicKey: CryptoKey, day: string = utcDayString()): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', topicKey, utf8Encode(`topic:${day}`));
  return toBase64Url(new Uint8Array(mac));
}

export async function deriveDeviceId(signingPublicRaw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBufferView(signingPublicRaw)));
  return toBase64Url(digest.subarray(0, 16));
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const [signing, agreement] = await Promise.all([
    crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as Promise<CryptoKeyPair>,
    crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as Promise<CryptoKeyPair>,
  ]);
  const [signingPublicBuf, agreementPublicBuf] = await Promise.all([
    crypto.subtle.exportKey('raw', signing.publicKey),
    crypto.subtle.exportKey('raw', agreement.publicKey),
  ]);
  const signingPublicRaw = new Uint8Array(signingPublicBuf);
  const agreementPublicRaw = new Uint8Array(agreementPublicBuf);
  const deviceId = await deriveDeviceId(signingPublicRaw);
  return { deviceId, signing, agreement, signingPublicRaw, agreementPublicRaw };
}

export function serializeDevicePublicKeys(keys: DeviceKeys): SerializedDevicePublicKeys {
  return {
    deviceId: keys.deviceId,
    signingPublic: toBase64Url(keys.signingPublicRaw),
    agreementPublic: toBase64Url(keys.agreementPublicRaw),
  };
}

export async function importPeerSigningKey(signingPublicBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64Url(signingPublicBase64Url);
  return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify']);
}

export async function importPeerAgreementKey(agreementPublicBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64Url(agreementPublicBase64Url);
  return crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, []);
}

export async function signEd25519(privateKey: CryptoKey, payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, toArrayBufferView(payload));
  return new Uint8Array(sig);
}

export async function verifyEd25519(publicKey: CryptoKey, signature: Uint8Array, payload: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    toArrayBufferView(signature),
    toArrayBufferView(payload),
  );
}

function chooseBucketSize(minTotalBytes: number): number {
  for (const bucket of RELAY_FRAME_BUCKETS) {
    if (bucket >= minTotalBytes) return bucket;
  }
  throw new Error(`Relay frame payload too large (${minTotalBytes} > ${MAX_RELAY_FRAME_BYTES} bytes)`);
}

/**
 * Seals a JSON signaling or relay-fallback payload into a padded binary frame
 * using signalKey (AES-256-GCM) with version + groupHint as AAD.
 */
export async function sealRelayFrame(
  groupKeys: Pick<GroupKeys, 'signalKey' | 'groupHint'>,
  payload: unknown,
): Promise<Uint8Array<ArrayBuffer>> {
  const raw = utf8Encode(JSON.stringify(payload));
  const plainLen = 2 + raw.byteLength;
  const totalBytes = chooseBucketSize(FRAME_HEADER_BYTES + plainLen + AES_GCM_TAG_BYTES);
  const paddedPlainLen = totalBytes - FRAME_HEADER_BYTES - AES_GCM_TAG_BYTES;
  const padded = new Uint8Array(new ArrayBuffer(paddedPlainLen));
  new DataView(padded.buffer).setUint16(0, raw.byteLength, false);
  padded.set(raw, 2);

  const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  crypto.getRandomValues(nonce);

  const aad = new Uint8Array(new ArrayBuffer(5));
  aad[0] = SYNC_PROTOCOL_VERSION;
  aad.set(groupKeys.groupHint, 1);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, groupKeys.signalKey, padded),
  );
  return concatBytes(aad, nonce, ciphertext);
}

export async function openRelayFrame<T = unknown>(
  groupKeys: Pick<GroupKeys, 'signalKey' | 'groupHint'>,
  frame: Uint8Array,
): Promise<T> {
  if (frame.byteLength < FRAME_HEADER_BYTES + 2 + AES_GCM_TAG_BYTES || frame.byteLength > MAX_RELAY_FRAME_BYTES) {
    throw new Error(`Invalid relay frame size: ${frame.byteLength}`);
  }
  if (frame[0] !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Unsupported relay frame version: ${frame[0]}`);
  }
  for (let i = 0; i < 4; i++) {
    if (frame[1 + i] !== groupKeys.groupHint[i]) {
      throw new Error('Relay frame group hint mismatch');
    }
  }
  const aad = toArrayBufferView(frame.subarray(0, 5));
  const nonce = toArrayBufferView(frame.subarray(5, FRAME_HEADER_BYTES));
  const ciphertext = toArrayBufferView(frame.subarray(FRAME_HEADER_BYTES));

  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, groupKeys.signalKey, ciphertext),
  );
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  if (2 + len > padded.byteLength) throw new Error('Corrupt padded relay frame length');
  return JSON.parse(utf8Decode(padded.subarray(2, 2 + len))) as T;
}

export async function sealRecordBody(
  recordKey: CryptoKey,
  aadText: string,
  body: unknown,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  crypto.getRandomValues(nonce);
  const plaintext = utf8Encode(JSON.stringify(body));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8Encode(aadText) },
      recordKey,
      plaintext,
    ),
  );
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export async function openRecordBody<T = unknown>(
  recordKey: CryptoKey,
  aadText: string,
  nonceBase64Url: string,
  ciphertextBase64Url: string,
): Promise<T> {
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(nonceBase64Url), additionalData: utf8Encode(aadText) },
      recordKey,
      fromBase64Url(ciphertextBase64Url),
    ),
  );
  return JSON.parse(utf8Decode(plaintext)) as T;
}

/**
 * Wraps a 32-byte epoch secret for a specific recipient using X25519 ECDH + HKDF + AES-256-GCM.
 */
export async function wrapGroupEntropyForPeer(
  sender: DeviceKeys,
  recipientDeviceId: string,
  recipientAgreementPublicBase64Url: string,
  epoch: number,
  newEntropy: Uint8Array,
): Promise<WrappedEpochSecret> {
  const peerPub = await importPeerAgreementKey(recipientAgreementPublicBase64Url);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peerPub }, sender.agreement.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = utf8Encode(`kiwi-sync/v1/wrap/epoch/${epoch}/${sender.deviceId}/${recipientDeviceId}`);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  crypto.getRandomValues(nonce);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: info }, wrapKey, toArrayBufferView(newEntropy)),
  );
  return {
    epoch,
    senderDeviceId: sender.deviceId,
    senderAgreementPublic: toBase64Url(sender.agreementPublicRaw),
    recipientDeviceId,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
  };
}

export async function unwrapGroupEntropyFromPeer(
  recipient: DeviceKeys,
  wrapped: WrappedEpochSecret,
): Promise<Uint8Array<ArrayBuffer>> {
  if (wrapped.recipientDeviceId !== recipient.deviceId) {
    throw new Error('Wrapped epoch secret is for a different device');
  }
  const senderPub = await importPeerAgreementKey(wrapped.senderAgreementPublic);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: senderPub }, recipient.agreement.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = utf8Encode(
    `kiwi-sync/v1/wrap/epoch/${wrapped.epoch}/${wrapped.senderDeviceId}/${wrapped.recipientDeviceId}`,
  );
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(wrapped.nonce), additionalData: info },
    wrapKey,
    fromBase64Url(wrapped.ciphertext),
  );
  return new Uint8Array(plain);
}

/**
 * Tracks seen frame IDs and enforces a sliding timestamp window to reject replayed or stale relay frames.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = 5 * 60 * 1000, private readonly maxEntries = 4096) {}

  accept(id: string, timestampMs: number, nowMs = Date.now()): boolean {
    if (!id || typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return false;
    if (Math.abs(nowMs - timestampMs) > this.windowMs) return false;
    this.prune(nowMs);
    if (this.seen.has(id)) return false;
    this.seen.set(id, timestampMs);
    if (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
    return true;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(key);
    }
  }
}
