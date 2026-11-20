import {
  canonicalJson,
  fromBase64Url,
  toBase64Url,
  utf8Encode,
} from './encoding';
import {
  deriveDeviceId,
  importPeerSigningKey,
  signEd25519,
  SYNC_PROTOCOL_VERSION,
  verifyEd25519,
  type DeviceKeys,
  type GroupKeys,
} from './crypto';

export interface HandshakeHello {
  protocolVersion: number;
  deviceId: string;
  deviceName: string;
  epoch: number;
  signingPublic: string;
  agreementPublic: string;
  ownCertHash: string;
  peerCertHash: string;
}

export interface HandshakeProof {
  mode: 'member-hmac' | 'device-ed25519';
  deviceId: string;
  proof: string;
}

export function buildHandshakeHello(params: {
  device: DeviceKeys;
  deviceName: string;
  epoch: number;
  ownCertHash: string;
  peerCertHash: string;
}): HandshakeHello {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    deviceId: params.device.deviceId,
    deviceName: params.deviceName,
    epoch: params.epoch,
    signingPublic: toBase64Url(params.device.signingPublicRaw),
    agreementPublic: toBase64Url(params.device.agreementPublicRaw),
    ownCertHash: params.ownCertHash,
    peerCertHash: params.peerCertHash,
  };
}

export function buildHandshakeTranscript(a: HandshakeHello, b: HandshakeHello): Uint8Array<ArrayBuffer> {
  const ordered = a.deviceId <= b.deviceId ? [a, b] : [b, a];
  return utf8Encode(`kiwi-sync-handshake/v1:${canonicalJson(ordered)}`);
}

export async function createHandshakeProof(params: {
  localHello: HandshakeHello;
  remoteHello: HandshakeHello;
  device: DeviceKeys;
  groupKeys: Pick<GroupKeys, 'memberKey'>;
  knownPeer: boolean;
}): Promise<HandshakeProof> {
  const transcript = buildHandshakeTranscript(params.localHello, params.remoteHello);
  if (params.knownPeer) {
    const sig = await signEd25519(params.device.signing.privateKey, transcript);
    return { mode: 'device-ed25519', deviceId: params.device.deviceId, proof: toBase64Url(sig) };
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', params.groupKeys.memberKey, transcript));
  return { mode: 'member-hmac', deviceId: params.device.deviceId, proof: toBase64Url(mac) };
}

export async function verifyHandshakeProof(params: {
  localHello: HandshakeHello;
  remoteHello: HandshakeHello;
  remoteProof: HandshakeProof;
  groupKeys: Pick<GroupKeys, 'memberKey'>;
  knownPeerSigningPublic?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { localHello, remoteHello, remoteProof } = params;
  if (remoteHello.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    return { ok: false, reason: `Unsupported protocol version: ${remoteHello.protocolVersion}` };
  }
  if (remoteProof.deviceId !== remoteHello.deviceId) {
    return { ok: false, reason: 'Handshake proof deviceId mismatch' };
  }
  // Verify DTLS channel binding: remote must observe our ownCertHash as its peerCertHash and vice versa.
  if (remoteHello.peerCertHash !== localHello.ownCertHash || remoteHello.ownCertHash !== localHello.peerCertHash) {
    return { ok: false, reason: 'DTLS certificate channel binding mismatch' };
  }
  // Verify remote deviceId matches its Ed25519 public key.
  const expectedDeviceId = await deriveDeviceId(fromBase64Url(remoteHello.signingPublic));
  if (expectedDeviceId !== remoteHello.deviceId) {
    return { ok: false, reason: 'Remote deviceId does not match signing public key' };
  }

  const transcript = buildHandshakeTranscript(localHello, remoteHello);
  const proofBytes = fromBase64Url(remoteProof.proof);

  if (remoteProof.mode === 'device-ed25519') {
    const pubToUse = params.knownPeerSigningPublic ?? remoteHello.signingPublic;
    if (params.knownPeerSigningPublic && params.knownPeerSigningPublic !== remoteHello.signingPublic) {
      return { ok: false, reason: 'Remote signing public key changed for known device' };
    }
    const pubKey = await importPeerSigningKey(pubToUse);
    const valid = await verifyEd25519(pubKey, proofBytes, transcript);
    return valid ? { ok: true } : { ok: false, reason: 'Invalid Ed25519 handshake signature' };
  }

  if (remoteProof.mode === 'member-hmac') {
    const valid = await crypto.subtle.verify('HMAC', params.groupKeys.memberKey, proofBytes, transcript);
    return valid ? { ok: true } : { ok: false, reason: 'Invalid member-key HMAC handshake proof' };
  }

  return { ok: false, reason: 'Unknown handshake proof mode' };
}
