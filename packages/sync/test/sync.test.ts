import { describe, expect, it } from 'vitest';
import {
  BIP39_WORDLIST,
  buildHandshakeHello,
  classifySyncPath,
  canonicalJson,
  compareHlc,
  createHandshakeProof,
  createHlc,
  decodeConnectionCode,
  DEFAULT_SYNC_CATEGORIES,
  deriveGroupKeys,
  deriveGroupHint,
  deriveTopicId,
  encodeConnectionCode,
  entropyToPhrase,
  generateDeviceKeys,
  generateRecoveryPhrase,
  importGroupSecret,
  isHlcDriftAcceptable,
  makeMembershipElementPath,
  MAX_RELAY_FRAME_BYTES,
  MAX_FUTURE_DRIFT_MS,
  memberCertificate,
  openRelayFrame,
  openRecordBody,
  phraseToEntropy,
  RELAY_FRAME_BUCKETS,
  ReplayGuard,
  sealRelayFrame,
  sealRecordBody,
  signEd25519,
  SyncEngine,
  tickHlc,
  toBase64Url,
  type WrappedEpochSecret,
  type DeviceKeys,
  type SyncRecordEnvelope,
  unwrapGroupEntropyFromPeer,
  utf8Encode,
  validatePhrase,
  verifyHandshakeProof,
  verifyMemberCertificate,
} from '../src/index';

describe('BIP39 recovery phrase', () => {
  it('generates and round-trips 24-word phrases with 256-bit entropy', async () => {
    expect(BIP39_WORDLIST).toHaveLength(2048);
    const { phrase, entropy } = await generateRecoveryPhrase();
    expect(phrase.split(' ')).toHaveLength(24);
    expect(entropy.byteLength).toBe(32);

    const decoded = await phraseToEntropy(`  ${phrase.toUpperCase().replace(/ /g, '   ')}  `);
    expect(Array.from(decoded)).toEqual(Array.from(entropy));
    expect(await entropyToPhrase(decoded)).toBe(phrase);
    expect(await validatePhrase(phrase)).toEqual({ ok: true });
  });

  it('rejects bad checksum and unknown words', async () => {
    const { phrase } = await generateRecoveryPhrase();
    const words = phrase.split(' ');
    const swapped = [...words];
    swapped[23] = swapped[23] === 'abandon' ? 'ability' : 'abandon';
    const badChecksum = await validatePhrase(swapped.join(' '));
    expect(badChecksum.ok).toBe(false);

    const unknownWord = await validatePhrase([...words.slice(0, 23), 'notaword'].join(' '));
    expect(unknownWord.ok).toBe(false);
  });
});

describe('Group keys, relay frames, and connection codes', () => {
  it('derives daily topic IDs matching relay URL constraints and seals padded frames', async () => {
    const { entropy } = await generateRecoveryPhrase();
    const secret = await importGroupSecret(entropy);
    const keys = await deriveGroupKeys(secret, 1);

    const topicToday = await deriveTopicId(keys.topicKey, '2026-11-20');
    const topicTomorrow = await deriveTopicId(keys.topicKey, '2026-11-21');
    const nextEpochKeys = await deriveGroupKeys(secret, 9);
    expect(topicToday).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(topicToday).not.toBe(topicTomorrow);
    expect(await deriveTopicId(nextEpochKeys.topicKey, '2026-11-20')).toBe(topicToday);

    const frame = await sealRelayFrame(keys, { type: 'hello', from: 'dev-a', id: 'f1', t: 1000 }, Date.parse('2026-11-20T12:00:00Z'));
    expect(RELAY_FRAME_BUCKETS).toContain(frame.byteLength as (typeof RELAY_FRAME_BUCKETS)[number]);
    expect(await openRelayFrame(keys, frame, Date.parse('2026-11-21T12:00:00Z'))).toEqual({ type: 'hello', from: 'dev-a', id: 'f1', t: 1000 });
    expect(Array.from(await deriveGroupHint(keys.topicKey, '2026-11-20'))).not.toEqual(
      Array.from(await deriveGroupHint(keys.topicKey, '2026-11-21')),
    );
    const rotatedEpochFrame = await sealRelayFrame(
      nextEpochKeys,
      { type: 'hello', from: 'dev-a', id: 'f2', t: 1000 },
      Date.parse('2026-11-20T12:00:00Z'),
    );
    expect(await openRelayFrame(keys, rotatedEpochFrame, Date.parse('2026-11-21T12:00:00Z'))).toEqual({
      type: 'hello',
      from: 'dev-a',
      id: 'f2',
      t: 1000,
    });

    // Tampering fails decryption
    const tampered = new Uint8Array(frame);
    tampered[tampered.byteLength - 1]! ^= 0xff;
    await expect(openRelayFrame(keys, tampered)).rejects.toThrow();

    // Wrong group fails decryption
    const other = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    await expect(openRelayFrame(other, frame)).rejects.toThrow();
  });

  it('rejects replayed and stale frame IDs', () => {
    const guard = new ReplayGuard(60_000);
    expect(guard.accept('id-1', 100_000, 100_500)).toBe(true);
    expect(guard.accept('id-1', 100_000, 100_600)).toBe(false);
    expect(guard.accept('id-2', 10_000, 100_600)).toBe(false);
  });

  it('encodes and decodes kiwi1- connection codes', async () => {
    const secret = await importGroupSecret((await generateRecoveryPhrase()).entropy);
    const keys = await deriveGroupKeys(secret, 1);
    const payload = {
      kind: 'offer' as const,
      epoch: 2,
      deviceId: 'dev-a',
      timestampMs: 1_700_000_000_000,
      ufrag: 'abcd',
      pwd: 'secretpassword0123456789',
      fingerprint: 'AA:BB:CC:DD',
      candidates: [{ type: 'host' as const, address: '192.168.1.10', port: 54321, protocol: 'udp' as const }],
    };
    const code = await encodeConnectionCode(keys, payload, payload.timestampMs);
    expect(code.startsWith('kiwi1-')).toBe(true);
    const decoded = await decodeConnectionCode(keys, code, 60_000, payload.timestampMs + 5000);
    expect(decoded).toEqual(payload);
    expect(await decodeConnectionCode(keys, code, 0, payload.timestampMs + 86_400_000)).toEqual(payload);
    await expect(decodeConnectionCode(keys, code, 1000, payload.timestampMs + 5000)).rejects.toThrow(/expired/i);
  });
});

describe('DTLS-bound channel handshake', () => {
  it('verifies first-meeting HMAC and reconnection Ed25519, rejecting MITM cert mismatch', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const devA = await generateDeviceKeys();
    const devB = await generateDeviceKeys();

    const helloA = buildHandshakeHello({
      device: devA,
      deviceName: 'MacBook',
      epoch: 1,
      ownCertHash: 'cert-A',
      peerCertHash: 'cert-B',
    });
    const helloB = buildHandshakeHello({
      device: devB,
      deviceName: 'Desktop',
      epoch: 1,
      ownCertHash: 'cert-B',
      peerCertHash: 'cert-A',
    });

    const proofAFirst = await createHandshakeProof({
      localHello: helloA,
      remoteHello: helloB,
      device: devA,
      groupKeys,
      knownPeer: false,
    });
    expect(
      await verifyHandshakeProof({ localHello: helloB, remoteHello: helloA, remoteProof: proofAFirst, groupKeys }),
    ).toEqual({ ok: true });

    const proofAReconnect = await createHandshakeProof({
      localHello: helloA,
      remoteHello: helloB,
      device: devA,
      groupKeys,
      knownPeer: true,
    });
    expect(
      await verifyHandshakeProof({
        localHello: helloB,
        remoteHello: helloA,
        remoteProof: proofAReconnect,
        groupKeys,
        knownPeerSigningPublic: helloA.signingPublic,
      }),
    ).toEqual({ ok: true });

    // MITM cert mismatch fails
    const badHelloB = { ...helloB, peerCertHash: 'cert-MITM' };
    const mitmCheck = await verifyHandshakeProof({
      localHello: badHelloB,
      remoteHello: helloA,
      remoteProof: proofAFirst,
      groupKeys,
    });
    expect(mitmCheck.ok).toBe(false);
  });
});

describe('HLC and category classification', () => {
  it('enforces 24h future drift rejection and deterministic tie-break', () => {
    const now = 1_700_000_000_000;
    expect(isHlcDriftAcceptable({ ms: now + MAX_FUTURE_DRIFT_MS, counter: 0, deviceId: 'a' }, now)).toBe(true);
    expect(isHlcDriftAcceptable({ ms: now + MAX_FUTURE_DRIFT_MS + 1, counter: 0, deviceId: 'a' }, now)).toBe(false);
    expect(compareHlc({ ms: 100, counter: 0, deviceId: 'a' }, { ms: 100, counter: 0, deviceId: 'b' })).toBeLessThan(0);

    const t0 = createHlc('a', 5000);
    const t1 = tickHlc(t0, 'a', 4000); // clock went backwards
    expect(t1).toEqual({ ms: 5000, counter: 1, deviceId: 'a' });
  });

  it('classifies API keys/endpoints as keys (default off) and never leaks them into search/filters', () => {
    expect(DEFAULT_SYNC_CATEGORIES.keys).toBe(false);
    expect(classifySyncPath('config.llm.apiKey')).toBe('keys');
    expect(classifySyncPath('config.llm.baseUrl')).toBe('keys');
    expect(classifySyncPath('config.judge.apiKey')).toBe('keys');
    expect(classifySyncPath('config.sources.exa.apiKey')).toBe('keys');
    expect(classifySyncPath('config.sources.exa.enabled')).toBe('search');
    expect(classifySyncPath(makeMembershipElementPath('config.judge.blockedDomains', 'spam.test'))).toBe('filters');
    expect(classifySyncPath('config.judge.blocklists.recommended')).toBe('filters');
    expect(classifySyncPath('config.judge.rules')).toBe('filters');
    expect(classifySyncPath('ui:theme')).toBe('ui');
    expect(classifySyncPath('preferences.theme')).toBeNull();
    expect(classifySyncPath('bridge.mcpToken')).toBeNull();
  });
});

describe('SyncEngine multi-device synchronization', () => {
  async function makePeer(name: string, groupKeys: Awaited<ReturnType<typeof deriveGroupKeys>>, now = 1_700_000_000_000) {
    const device = await generateDeviceKeys();
    const engine = new SyncEngine({ device, deviceName: name, groupKeys, configVersion: 5, nowMs: now });
    await engine.createMemberJoinRecord(now);
    return { device, engine };
  }

  async function makeLegacyMemberJoin(
    device: DeviceKeys,
    groupKeys: Awaited<ReturnType<typeof deriveGroupKeys>>,
    nowMs: number,
  ): Promise<SyncRecordEnvelope> {
    const header = {
      deviceId: device.deviceId,
      seq: 1,
      epoch: groupKeys.epoch,
      hlc: createHlc(device.deviceId, nowMs),
      configVersion: 5,
      kind: 'member-join' as const,
    };
    const body = {
      kind: 'member-join' as const,
      deviceId: device.deviceId,
      deviceName: 'Legacy device',
      signingPublic: toBase64Url(device.signingPublicRaw),
      agreementPublic: toBase64Url(device.agreementPublicRaw),
    };
    const sealed = await sealRecordBody(groupKeys.recordKey, canonicalJson(header), body);
    const unsigned = {
      ...header,
      signingPublic: toBase64Url(device.signingPublicRaw),
      ...sealed,
    };
    const signature = await signEd25519(
      device.signing.privateKey,
      utf8Encode(`kiwi-sync-record/v1:${canonicalJson(unsigned)}`),
    );
    return { ...unsigned, signature: toBase64Url(signature) };
  }

  async function makeMemberJoinEnvelope(
    device: DeviceKeys,
    groupKeys: Awaited<ReturnType<typeof deriveGroupKeys>>,
    seq: number,
    agreementPublic: string,
    nowMs: number,
    agreementSig?: string,
  ): Promise<SyncRecordEnvelope> {
    const header = {
      deviceId: device.deviceId,
      seq,
      epoch: groupKeys.epoch,
      hlc: createHlc(device.deviceId, nowMs),
      configVersion: 5,
      kind: 'member-join' as const,
    };
    const body = {
      kind: 'member-join' as const,
      deviceId: device.deviceId,
      deviceName: 'Member',
      signingPublic: toBase64Url(device.signingPublicRaw),
      agreementPublic,
      ...(agreementSig ? { agreementSig } : {}),
    };
    const sealed = await sealRecordBody(groupKeys.recordKey, canonicalJson(header), body);
    const unsigned = {
      ...header,
      signingPublic: toBase64Url(device.signingPublicRaw),
      ...sealed,
    };
    const signature = await signEd25519(
      device.signing.privateKey,
      utf8Encode(`kiwi-sync-record/v1:${canonicalJson(unsigned)}`),
    );
    return { ...unsigned, signature: toBase64Url(signature) };
  }

  it('verifies epoch-independent member certificates against device identity and agreement keys', async () => {
    const device = await generateDeviceKeys();
    const fields = {
      deviceId: device.deviceId,
      signingPublic: toBase64Url(device.signingPublicRaw),
      agreementPublic: toBase64Url(device.agreementPublicRaw),
      agreementSig: device.agreementSig!,
    };

    expect(await memberCertificate(device)).toBe(fields.agreementSig);
    expect(await verifyMemberCertificate(fields)).toBe(true);
    expect(
      await verifyMemberCertificate({
        ...fields,
        agreementPublic: toBase64Url((await generateDeviceKeys()).agreementPublicRaw),
      }),
    ).toBe(false);
    expect(await verifyMemberCertificate({ ...fields, deviceId: 'wrong-device' })).toBe(false);
  });

  it('attests snapshot-only members and wraps the next epoch secret for them', async () => {
    const originalKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', originalKeys, now);
    const C = await makePeer('C', originalKeys, now);
    await A.engine.receiveRecords(C.engine.getAllEnvelopes(), now + 10);
    expect(A.engine.getMembers().find((member) => member.deviceId === C.device.deviceId)).toMatchObject({
      agreementSig: C.device.agreementSig,
      agreementAttested: true,
    });

    const { entropy: secondEntropy } = await generateRecoveryPhrase();
    const firstRotation = await A.engine.rotatePhrase(secondEntropy, now + 20);
    const cFirstRotation = await C.engine.receiveRecords([firstRotation.envelope], now + 30);
    expect(cFirstRotation.epochRotatedTo).toBe(2);

    const snapshotEngine = new SyncEngine({
      device: A.device,
      deviceName: 'A',
      groupKeys: firstRotation.newGroupKeys,
      configVersion: 5,
      persisted: A.engine.exportState(),
    });
    const snapshot = await snapshotEngine.createSnapshotRecords(now + 40);
    const D = await makePeer('D', firstRotation.newGroupKeys, now);
    await D.engine.receiveRecords(snapshot.records, now + 50);

    expect(D.engine.getAllEnvelopes().some((record) => record.deviceId === C.device.deviceId)).toBe(false);
    expect(D.engine.getMembers().find((member) => member.deviceId === C.device.deviceId)).toMatchObject({
      agreementPublic: toBase64Url(C.device.agreementPublicRaw),
      agreementSig: C.device.agreementSig,
      agreementAttested: true,
    });

    const { entropy: thirdEntropy } = await generateRecoveryPhrase();
    const secondRotation = await D.engine.rotatePhrase(thirdEntropy, now + 60);
    const cSecondRotation = await C.engine.receiveRecords([secondRotation.envelope], now + 70);
    expect(cSecondRotation.epochRotatedTo).toBe(3);
  });

  it('does not attest or wrap snapshot substitutions with a forged or missing certificate', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const B = await makePeer('B', groupKeys, now);
    const C = await makePeer('C', groupKeys, now);
    const actualC = C.engine.getMembers()[0]!;
    const substitutedAgreement = toBase64Url(B.device.agreementPublicRaw);

    for (const [name, agreementSig] of [
      ['forged', B.device.agreementSig!],
      ['missing', ''],
    ] as const) {
      const snapshotState = B.engine.exportState();
      snapshotState.members[C.device.deviceId] = {
        ...actualC,
        agreementPublic: substitutedAgreement,
        agreementSig,
        agreementAttested: true,
      };
      const snapshotEngine = new SyncEngine({
        device: B.device,
        deviceName: 'B',
        groupKeys,
        configVersion: 5,
        persisted: snapshotState,
      });
      const snapshot = await snapshotEngine.createSnapshotRecords(now + 10);
      const D = await makePeer(`D-${name}`, groupKeys, now);
      const received = await D.engine.receiveRecords(snapshot.records, now + 20);
      expect(received.accepted).toBe(snapshot.records.length);
      expect(D.engine.getMembers().find((member) => member.deviceId === C.device.deviceId)).toMatchObject({
        agreementPublic: substitutedAgreement,
        agreementAttested: false,
      });

      const { envelope } = await D.engine.rotatePhrase((await generateRecoveryPhrase()).entropy, now + 30);
      const body = await openRecordBody<{ wrappedSecrets: Array<{ recipientDeviceId: string }> }>(
        groupKeys.recordKey,
        canonicalJson({
          deviceId: envelope.deviceId,
          seq: envelope.seq,
          epoch: envelope.epoch,
          hlc: envelope.hlc,
          configVersion: envelope.configVersion,
          kind: envelope.kind,
        }),
        envelope.nonce,
        envelope.ciphertext,
      );
      expect(body.wrappedSecrets.some((wrapped) => wrapped.recipientDeviceId === C.device.deviceId)).toBe(false);
    }
  });

  it('restores legacy member joins, catches up without snapshots, and wraps rotations for existing members', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const makeLegacyPeer = async (name: string) => {
      const device = await generateDeviceKeys();
      delete device.agreementSig;
      const initial = new SyncEngine({ device, deviceName: name, groupKeys, configVersion: 5, nowMs: now });
      const memberJoin = await makeLegacyMemberJoin(device, groupKeys, now);
      const persisted = initial.exportState();
      persisted.seq = memberJoin.seq;
      persisted.versionVector[device.deviceId] = memberJoin.seq;
      persisted.recordLog = [memberJoin];
      persisted.members[device.deviceId] = {
        ...persisted.members[device.deviceId]!,
        agreementSig: '',
        agreementAttested: true,
      };
      const engine = new SyncEngine({
        device,
        deviceName: name,
        groupKeys,
        configVersion: 5,
        persisted,
      });
      return { device, engine, memberJoin };
    };
    const A = await makeLegacyPeer('A');
    const B = await makeLegacyPeer('B');
    await A.engine.receiveRecords([B.memberJoin], now + 2);
    await B.engine.receiveRecords([A.memberJoin], now + 2);

    await A.engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'news' }], now + 3);
    const restoredA = new SyncEngine({
      device: A.device,
      deviceName: 'A',
      groupKeys,
      configVersion: 5,
      persisted: A.engine.exportState(),
    });
    const restoredB = new SyncEngine({
      device: B.device,
      deviceName: 'B',
      groupKeys,
      configVersion: 5,
      persisted: B.engine.exportState(),
    });
    const ordinaryCatchup = [
      ...restoredA.getAllEnvelopes().filter((record) => record.deviceId === A.device.deviceId),
      ...restoredB.getAllEnvelopes().filter((record) => record.deviceId === B.device.deviceId),
    ];
    expect(ordinaryCatchup.every((record) => record.kind !== 'snapshot')).toBe(true);

    const D = await makePeer('D', groupKeys, now);
    const catchupResult = await D.engine.receiveRecords(ordinaryCatchup, now + 4);
    expect(catchupResult.accepted).toBe(3);
    expect(D.engine.getRegisters()['config.defaultMode']?.value).toBe('news');
    expect(D.engine.getMembers().find((member) => member.deviceId === A.device.deviceId)).toMatchObject({
      agreementSig: '',
      agreementAttested: true,
    });
    expect(D.engine.getMembers().find((member) => member.deviceId === B.device.deviceId)).toMatchObject({
      agreementSig: '',
      agreementAttested: true,
    });

    const { envelope } = await D.engine.rotatePhrase((await generateRecoveryPhrase()).entropy, now + 5);
    expect((await restoredA.receiveRecords([envelope], now + 6)).epochRotatedTo).toBe(2);
    expect((await restoredB.receiveRecords([envelope], now + 6)).epochRotatedTo).toBe(2);
  });

  it('does not restore an older agreement key from an out-of-order member join', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const receiver = await makePeer('Receiver', groupKeys, now);
    const member = await generateDeviceKeys();
    const olderKey = await generateDeviceKeys();
    const newestJoin = await makeMemberJoinEnvelope(
      member,
      groupKeys,
      2,
      toBase64Url(member.agreementPublicRaw),
      now + 2,
      member.agreementSig,
    );
    const olderJoin = await makeMemberJoinEnvelope(
      member,
      groupKeys,
      1,
      toBase64Url(olderKey.agreementPublicRaw),
      now + 1,
    );

    expect((await receiver.engine.receiveRecords([newestJoin], now + 3)).accepted).toBe(1);
    expect((await receiver.engine.receiveRecords([olderJoin], now + 4)).accepted).toBe(1);
    expect(receiver.engine.getMembers().find((entry) => entry.deviceId === member.deviceId)).toMatchObject({
      agreementPublic: toBase64Url(member.agreementPublicRaw),
      agreementSig: member.agreementSig,
      agreementAttested: true,
      agreementSeq: 2,
    });

    const receiverState = receiver.engine.exportState();
    receiverState.members[member.deviceId]!.agreementAttested = false;
    const snapshotReceiver = new SyncEngine({
      device: receiver.device,
      deviceName: 'Receiver',
      groupKeys,
      configVersion: 5,
      persisted: receiverState,
    });
    const snapshotSource = await makePeer('SnapshotSource', groupKeys, now);
    const snapshotState = snapshotSource.engine.exportState();
    const olderAgreementPublic = toBase64Url(olderKey.agreementPublicRaw);
    const olderAgreementSig = toBase64Url(
      await signEd25519(
        member.signing.privateKey,
        utf8Encode(
          canonicalJson([
            'kiwi-sync/v1/member-cert',
            member.deviceId,
            toBase64Url(member.signingPublicRaw),
            olderAgreementPublic,
          ]),
        ),
      ),
    );
    snapshotState.members[member.deviceId] = {
      deviceId: member.deviceId,
      deviceName: 'Member',
      signingPublic: toBase64Url(member.signingPublicRaw),
      agreementPublic: olderAgreementPublic,
      agreementSig: olderAgreementSig,
      agreementAttested: true,
      agreementSeq: 1,
      joinedAt: now,
      lastSeenAt: now,
    };
    const snapshotSourceEngine = new SyncEngine({
      device: snapshotSource.device,
      deviceName: 'SnapshotSource',
      groupKeys,
      configVersion: 5,
      persisted: snapshotState,
    });
    const snapshot = await snapshotSourceEngine.createSnapshotRecords(now + 5);
    expect((await snapshotReceiver.receiveRecords(snapshot.records, now + 6)).accepted).toBe(snapshot.records.length);
    expect(snapshotReceiver.getMembers().find((entry) => entry.deviceId === member.deviceId)).toMatchObject({
      agreementPublic: toBase64Url(member.agreementPublicRaw),
      agreementAttested: false,
      agreementSeq: 2,
    });
  });

  it('propagates a valid certificate for a legacy-attested key through snapshots and rotations', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await generateDeviceKeys();
    const Bengine = new SyncEngine({ device: B, deviceName: 'B', groupKeys, configVersion: 5, nowMs: now });
    const legacyJoin = await makeLegacyMemberJoin(B, groupKeys, now + 1);
    await Bengine.createMemberJoinRecord(now + 2);
    const certifiedJoin = await Bengine.createMemberJoinRecord(now + 3);
    const C = await makePeer('C', groupKeys, now);

    expect((await A.engine.receiveRecords([legacyJoin], now + 3)).accepted).toBe(1);
    expect((await C.engine.receiveRecords([certifiedJoin], now + 4)).accepted).toBe(1);
    expect(A.engine.getMembers().find((member) => member.deviceId === B.deviceId)).toMatchObject({
      agreementSig: '',
      agreementAttested: true,
      agreementSeq: 1,
    });

    const cSnapshot = await C.engine.createSnapshotRecords(now + 5);
    await A.engine.receiveRecords(cSnapshot.records, now + 6);
    expect(A.engine.getMembers().find((member) => member.deviceId === B.deviceId)).toMatchObject({
      agreementSig: B.agreementSig,
      agreementAttested: true,
      agreementSeq: 2,
    });

    const aSnapshot = await A.engine.createSnapshotRecords(now + 7);
    const D = await makePeer('D', groupKeys, now);
    await D.engine.receiveRecords(aSnapshot.records, now + 8);
    expect(D.engine.getMembers().find((member) => member.deviceId === B.deviceId)).toMatchObject({
      agreementSig: B.agreementSig,
      agreementAttested: true,
      agreementSeq: 2,
    });

    const { envelope } = await D.engine.rotatePhrase((await generateRecoveryPhrase()).entropy, now + 9);
    const rotation = await openRecordBody<{ wrappedSecrets: WrappedEpochSecret[] }>(
      groupKeys.recordKey,
      canonicalJson({
        deviceId: envelope.deviceId,
        seq: envelope.seq,
        epoch: envelope.epoch,
        hlc: envelope.hlc,
        configVersion: envelope.configVersion,
        kind: envelope.kind,
      }),
      envelope.nonce,
      envelope.ciphertext,
    );
    expect(rotation.wrappedSecrets.some((wrapped) => wrapped.recipientDeviceId === B.deviceId)).toBe(true);
  });

  it('serializes concurrent local changes into unique record sequences', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const device = await generateDeviceKeys();
    const engine = new SyncEngine({ device, deviceName: 'A', groupKeys, configVersion: 5, nowMs: 1_700_000_000_000 });
    const [first, second] = await Promise.all([
      engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'news' }], 1_700_000_000_100),
      engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'video' }], 1_700_000_000_100),
    ]);

    expect([first[0]!.seq, second[0]!.seq].sort()).toEqual([1, 2]);
    expect(engine.getAllEnvelopes().map((record) => record.seq).sort()).toEqual([1, 2]);
  });

  it('resolves concurrent LWW conflicts deterministically, merges membership sets, and propagates via third device', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);
    const C = await makePeer('C', groupKeys, now);

    // Concurrent edit to same scalar path at identical ms (tie-break by deviceId)
    await A.engine.applyLocalChanges(
      [
        { path: 'config.defaultMode', value: 'news' },
        { path: makeMembershipElementPath('config.judge.blockedDomains', 'farm-a.test'), value: true },
      ],
      now + 1000,
    );
    await B.engine.applyLocalChanges(
      [
        { path: 'config.defaultMode', value: 'academic' },
        { path: makeMembershipElementPath('config.judge.blockedDomains', 'farm-b.test'), value: true },
      ],
      now + 1000,
    );

    // A <-> B sync
    const forB = A.engine.missingRecordsFor(B.engine.getVersionVector());
    const forA = B.engine.missingRecordsFor(A.engine.getVersionVector());
    await B.engine.receiveRecords(forB, now + 2000);
    await A.engine.receiveRecords(forA, now + 2000);

    // Duplicate delivery is idempotent
    const dupRes = await B.engine.receiveRecords(forB, now + 2100);
    expect(dupRes.duplicates).toBe(forB.length);
    expect(dupRes.accepted).toBe(0);

    // Both converge to exact same scalar winner and keep BOTH blocked domains
    const winner = A.engine.getRegisters()['config.defaultMode']!.value;
    expect(B.engine.getRegisters()['config.defaultMode']!.value).toBe(winner);
    expect(A.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'farm-a.test')]?.value).toBe(true);
    expect(A.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'farm-b.test')]?.value).toBe(true);
    expect(B.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'farm-a.test')]?.value).toBe(true);
    expect(B.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'farm-b.test')]?.value).toBe(true);

    // Third-device indirect propagation: A never talks to C, only B talks to C!
    const forC = B.engine.missingRecordsFor(C.engine.getVersionVector());
    await C.engine.receiveRecords(forC, now + 3000);
    expect(C.engine.getRegisters()['config.defaultMode']!.value).toBe(winner);
    expect(C.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'farm-a.test')]?.value).toBe(true);
    expect(C.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'farm-b.test')]?.value).toBe(true);
  });

  it('keeps API keys off by default and syncs them only when explicitly enabled on both devices', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);

    // Default off: local key edit emits nothing
    const emittedOff = await A.engine.applyLocalChanges([{ path: 'config.llm.apiKey', value: 'sk-test-1' }], now + 100);
    expect(emittedOff).toHaveLength(0);

    // Enable on A only: A emits, B receives into register but does NOT apply locally while B.keys is false
    await A.engine.setCategories({ keys: true });
    const emittedOn = await A.engine.applyLocalChanges([{ path: 'config.llm.apiKey', value: 'sk-test-2' }], now + 200);
    expect(emittedOn).toHaveLength(1);

    const resBOff = await B.engine.receiveRecords(emittedOn, now + 300);
    expect(resBOff.accepted).toBe(1);
    expect(resBOff.applied).toHaveLength(0);

    // Enable on B and send newer key from A -> B applies it
    await B.engine.setCategories({ keys: true });
    const emittedOn2 = await A.engine.applyLocalChanges([{ path: 'config.llm.apiKey', value: 'sk-test-3' }], now + 400);
    const resBOn = await B.engine.receiveRecords(emittedOn2, now + 500);
    expect(resBOn.applied).toHaveLength(1);
    expect(resBOn.applied[0]).toMatchObject({ path: 'config.llm.apiKey', value: 'sk-test-3', category: 'keys' });
  });

  it('keeps the version vector at a contiguous prefix for out-of-order records', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);
    const seq2 = await A.engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'news' }], now + 100);
    const seq1 = A.engine.getAllEnvelopes().find((record) => record.deviceId === A.device.deviceId && record.seq === 1)!;

    const outOfOrder = await B.engine.receiveRecords(seq2, now + 200);
    expect(outOfOrder.accepted).toBe(1);
    expect(B.engine.getVersionVector()[A.device.deviceId] ?? 0).toBe(0);
    expect(B.engine.getRegisters()['config.defaultMode']?.value).toBe('news');

    await B.engine.receiveRecords([seq1], now + 300);
    expect(B.engine.getVersionVector()[A.device.deviceId]).toBe(2);
  });

  it('uses snapshot coverage to catch up across compacted record gaps', async () => {
    const oldKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', oldKeys, now);
    await A.engine.setCategories({ keys: true });
    await A.engine.applyLocalChanges([
      { path: 'config.defaultMode', value: 'academic' },
      { path: 'config.llm.apiKey', value: 'sk-snapshot-test' },
    ], now + 100);
    const { entropy: rotatedEntropy } = await generateRecoveryPhrase();
    const { newGroupKeys } = await A.engine.rotatePhrase(rotatedEntropy, now + 200);
    const snapshotState = A.engine.exportState();
    for (let index = 0; index < 120; index += 1) {
      const path = makeMembershipElementPath('config.judge.blockedDomains', `host-${index}.example`);
      snapshotState.registers[path] = {
        path,
        value: true,
        tombstone: false,
        hlc: createHlc(A.device.deviceId, now + 250),
        deviceId: A.device.deviceId,
        seq: index + 1,
        configVersion: 5,
        category: 'filters',
      };
    }
    const snapshotEngine = new SyncEngine({
      device: A.device,
      deviceName: 'A',
      groupKeys: newGroupKeys,
      configVersion: 5,
      categories: snapshotState.categories,
      persisted: snapshotState,
    });
    const snapshots = await snapshotEngine.createSnapshotRecords(now + 300);
    expect(snapshots.records.length).toBeGreaterThan(1);
    expect(snapshots.records.every((record) => utf8Encode(JSON.stringify(record)).byteLength <= MAX_RELAY_FRAME_BYTES)).toBe(true);
    const D = await makePeer('D', newGroupKeys, now);

    const received = await D.engine.receiveRecords(snapshots.records, now + 400);
    expect(received.accepted).toBe(snapshots.records.length);
    expect(D.engine.getRegisters()['config.defaultMode']?.value).toBe('academic');
    expect(D.engine.getRegisters()['config.llm.apiKey']?.value).toBe('sk-snapshot-test');
    expect(received.applied.some((change) => change.path === 'config.llm.apiKey')).toBe(false);
    expect(D.engine.getVersionVector()[A.device.deviceId]).toBe(snapshotEngine.getVersionVector()[A.device.deviceId]);

    const B = await makePeer('B', oldKeys, now);
    const oldEpochResult = await B.engine.receiveRecords(snapshots.records, now + 400);
    expect(oldEpochResult.accepted).toBe(0);
    expect(oldEpochResult.rejected[0]!.reason).toMatch(/Unknown epoch/i);
  });

  it('bootstraps active and removed member identities and enforces removals', async () => {
    const oldKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', oldKeys, now);
    const B = await makePeer('B', oldKeys, now);
    await A.engine.receiveRecords(B.engine.getAllEnvelopes(), now + 10);

    const { entropy } = await generateRecoveryPhrase();
    const { newGroupKeys } = await A.engine.removeDevice(B.device.deviceId, entropy, now + 20);
    const snapshotState = A.engine.exportState();
    const snapshotEngine = new SyncEngine({
      device: A.device,
      deviceName: 'A',
      groupKeys: newGroupKeys,
      configVersion: 5,
      persisted: snapshotState,
    });
    const snapshots = await snapshotEngine.createSnapshotRecords(now + 30);
    const D = await makePeer('D', newGroupKeys, now);
    await D.engine.registerEpochKeys(oldKeys);

    const result = await D.engine.receiveRecords(snapshots.records, now + 40);
    expect(result.accepted).toBe(snapshots.records.length);
    const restoredMembers = D.engine.getMembers();
    expect(restoredMembers.find((member) => member.deviceId === A.device.deviceId)?.signingPublic)
      .toBe(toBase64Url(A.device.signingPublicRaw));
    expect(restoredMembers.find((member) => member.deviceId === B.device.deviceId)).toMatchObject({
      signingPublic: toBase64Url(B.device.signingPublicRaw),
      agreementPublic: toBase64Url(B.device.agreementPublicRaw),
      removedAt: expect.any(Number),
    });

    const rogue = await B.engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'video' }], now + 50);
    const rejected = await D.engine.receiveRecords(rogue, now + 60);
    expect(rejected.accepted).toBe(0);
    expect(rejected.rejected[0]!.reason).toMatch(/removed/i);
  });

  it('rejects snapshot member metadata that fails the device signing-key identity check', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const state = A.engine.exportState();
    state.members['forged-device'] = {
      deviceId: 'forged-device',
      deviceName: 'Forged',
      signingPublic: toBase64Url(A.device.signingPublicRaw),
      agreementPublic: toBase64Url(A.device.agreementPublicRaw),
      agreementSig: '',
      agreementAttested: false,
      agreementSeq: 0,
      joinedAt: now,
      lastSeenAt: now,
    };
    const snapshotEngine = new SyncEngine({
      device: A.device,
      deviceName: 'A',
      groupKeys,
      configVersion: 5,
      persisted: state,
    });
    const snapshot = await snapshotEngine.createSnapshotRecords(now + 10);
    const D = await makePeer('D', groupKeys, now);
    const result = await D.engine.receiveRecords(snapshot.records, now + 20);

    expect(result.accepted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/snapshot member identity/i);
    expect(D.engine.getMembers().some((member) => member.deviceId === 'forged-device')).toBe(false);
  });

  it('does not trust snapshot agreement keys until the member signs its own join', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const B = await makePeer('B', groupKeys, now);
    const C = await makePeer('C', groupKeys, now);
    const D = await makePeer('D', groupKeys, now);
    const snapshotState = B.engine.exportState();
    const actualC = C.engine.getMembers()[0]!;
    const substitutedAgreement = toBase64Url(B.device.agreementPublicRaw);
    snapshotState.members[C.device.deviceId] = {
      ...actualC,
      agreementPublic: substitutedAgreement,
      agreementAttested: true,
    };
    const snapshotEngine = new SyncEngine({
      device: B.device,
      deviceName: 'B',
      groupKeys,
      configVersion: 5,
      persisted: snapshotState,
    });
    const snapshot = await snapshotEngine.createSnapshotRecords(now + 10);
    await D.engine.receiveRecords(snapshot.records, now + 20);

    expect(D.engine.getMembers().find((member) => member.deviceId === C.device.deviceId)).toMatchObject({
      agreementPublic: substitutedAgreement,
      agreementAttested: false,
    });

    const { entropy: firstEntropy } = await generateRecoveryPhrase();
    const firstRotation = await D.engine.rotatePhrase(firstEntropy, now + 30);
    const firstBody = await openRecordBody<{ wrappedSecrets: Array<{ recipientDeviceId: string }> }>(
      groupKeys.recordKey,
      canonicalJson({
        deviceId: firstRotation.envelope.deviceId,
        seq: firstRotation.envelope.seq,
        epoch: firstRotation.envelope.epoch,
        hlc: firstRotation.envelope.hlc,
        configVersion: firstRotation.envelope.configVersion,
        kind: firstRotation.envelope.kind,
      }),
      firstRotation.envelope.nonce,
      firstRotation.envelope.ciphertext,
    );
    expect(firstBody.wrappedSecrets.some((wrapped) => wrapped.recipientDeviceId === C.device.deviceId)).toBe(false);
    expect(firstBody.wrappedSecrets.some((wrapped) => wrapped.recipientDeviceId === D.device.deviceId)).toBe(true);

    const genuineJoin = C.engine.getAllEnvelopes().find((record) => record.kind === 'member-join')!;
    const joinResult = await D.engine.receiveRecords([genuineJoin], now + 40);
    expect(joinResult.accepted).toBe(1);
    expect(D.engine.getMembers().find((member) => member.deviceId === C.device.deviceId)).toMatchObject({
      agreementPublic: toBase64Url(C.device.agreementPublicRaw),
      agreementAttested: true,
    });

    const { entropy: secondEntropy } = await generateRecoveryPhrase();
    const secondRotation = await D.engine.rotatePhrase(secondEntropy, now + 50);
    const secondBody = await openRecordBody<{ wrappedSecrets: WrappedEpochSecret[] }>(
      firstRotation.newGroupKeys.recordKey,
      canonicalJson({
        deviceId: secondRotation.envelope.deviceId,
        seq: secondRotation.envelope.seq,
        epoch: secondRotation.envelope.epoch,
        hlc: secondRotation.envelope.hlc,
        configVersion: secondRotation.envelope.configVersion,
        kind: secondRotation.envelope.kind,
      }),
      secondRotation.envelope.nonce,
      secondRotation.envelope.ciphertext,
    );
    const wrappedForC = secondBody.wrappedSecrets.find((wrapped) => wrapped.recipientDeviceId === C.device.deviceId);
    expect(wrappedForC).toBeDefined();
    expect(Array.from(await unwrapGroupEntropyFromPeer(C.device, wrappedForC!))).toEqual(Array.from(secondEntropy));
  });

  it('loads persisted members without an agreement attestation field as legacy-attested', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const A = await makePeer('A', groupKeys);
    const state = A.engine.exportState();
    Reflect.deleteProperty(state.members[A.device.deviceId]!, 'agreementAttested');
    Reflect.deleteProperty(state.members[A.device.deviceId]!, 'agreementSeq');
    const restored = new SyncEngine({
      device: A.device,
      deviceName: 'A',
      groupKeys,
      configVersion: 5,
      persisted: state,
    });

    expect(restored.getMembers().find((member) => member.deviceId === A.device.deviceId)).toMatchObject({
      agreementAttested: true,
      agreementSeq: 0,
    });
  });

  it('skips and reports a single oversized register while continuing snapshot creation', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const oversizedPath = 'config.defaultMode';
    await A.engine.applyLocalChanges([
      { path: oversizedPath, value: 'x'.repeat(MAX_RELAY_FRAME_BYTES - 1_000) },
      { path: 'config.summary.enabled', value: false },
    ], now + 10);

    const snapshot = await A.engine.createSnapshotRecords(now + 20);
    expect(snapshot.skippedPaths).toContain(oversizedPath);
    expect(snapshot.records.length).toBeGreaterThan(0);
    expect(snapshot.records.every((record) => utf8Encode(JSON.stringify(record)).byteLength <= MAX_RELAY_FRAME_BYTES)).toBe(true);
    const D = await makePeer('D', groupKeys, now);
    const received = await D.engine.receiveRecords(snapshot.records, now + 30);
    expect(received.accepted).toBe(snapshot.records.length);
    expect(D.engine.getRegisters()['config.summary.enabled']?.value).toBe(false);
    expect(D.engine.getRegisters()[oversizedPath]).toBeUndefined();
  });

  it('rejects joins that name another device but accepts a member own-signed agreement-key update', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);
    const C = await makePeer('C', groupKeys, now);
    await A.engine.receiveRecords(B.engine.getAllEnvelopes(), now + 10);
    await A.engine.receiveRecords(C.engine.getAllEnvelopes(), now + 20);

    const signingPublic = toBase64Url(C.device.signingPublicRaw);
    const agreementPublic = toBase64Url(C.device.agreementPublicRaw);
    const forgedBody = {
      kind: 'member-join' as const,
      deviceId: B.device.deviceId,
      deviceName: 'forged B',
      signingPublic,
      agreementPublic,
    };
    const header = {
      deviceId: C.device.deviceId,
      seq: 2,
      epoch: 1,
      hlc: createHlc(C.device.deviceId, now + 30),
      configVersion: 5,
      kind: 'member-join' as const,
    };
    const aad = canonicalJson(header);
    const sealed = await sealRecordBody(groupKeys.recordKey, aad, forgedBody);
    const unsigned = { ...header, signingPublic, ...sealed };
    const signature = await signEd25519(
      C.device.signing.privateKey,
      utf8Encode(`kiwi-sync-record/v1:${canonicalJson(unsigned)}`),
    );
    const forged = { ...unsigned, signature: toBase64Url(signature) };

    const beforeAgreement = A.engine.getMembers().find((member) => member.deviceId === B.device.deviceId)?.agreementPublic;
    const result = await A.engine.receiveRecords([forged], now + 40);
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]!.reason).toMatch(/identity mismatch/i);
    expect(A.engine.getMembers().find((member) => member.deviceId === B.device.deviceId)?.agreementPublic).toBe(beforeAgreement);

    const changedAgreement = {
      ...forgedBody,
      deviceId: C.device.deviceId,
      deviceName: 'C',
      agreementPublic: toBase64Url(B.device.agreementPublicRaw),
    };
    const changedHeader = { ...header, seq: 3, hlc: createHlc(C.device.deviceId, now + 50) };
    const changedSealed = await sealRecordBody(groupKeys.recordKey, canonicalJson(changedHeader), changedAgreement);
    const changedUnsigned = { ...changedHeader, signingPublic, ...changedSealed };
    const changedSignature = await signEd25519(
      C.device.signing.privateKey,
      utf8Encode(`kiwi-sync-record/v1:${canonicalJson(changedUnsigned)}`),
    );
    const changed = { ...changedUnsigned, signature: toBase64Url(changedSignature) };
    const changedResult = await A.engine.receiveRecords([changed], now + 60);
    expect(changedResult.accepted).toBe(1);
    expect(A.engine.getMembers().find((member) => member.deviceId === C.device.deviceId)).toMatchObject({
      agreementPublic: toBase64Url(B.device.agreementPublicRaw),
      agreementAttested: true,
    });
  });

  it('rejects records with >24h future clock skew and clamps invalid numeric values', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);

    const futureRecords = await A.engine.applyLocalChanges(
      [{ path: 'config.defaultMode', value: 'images' }],
      now + MAX_FUTURE_DRIFT_MS + 60_000,
    );
    const res = await B.engine.receiveRecords(futureRecords, now);
    expect(res.accepted).toBe(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.reason).toMatch(/24h/i);

    // Clamping test (with a non-skewed peer C)
    const C = await makePeer('C', groupKeys, now);
    const clamped = await C.engine.applyLocalChanges([{ path: 'config.timeoutMs', value: 999_999 }], now + 100);
    const resClamped = await B.engine.receiveRecords(clamped, now + 200);
    expect(resClamped.applied[0]!.value).toBe(60_000);
  });

  it('supports device removal with epoch rotation and rejects subsequent records from removed device', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);
    const C = await makePeer('C', groupKeys, now);

    // Exchange member-join records so everyone knows everyone's X25519 key
    await A.engine.receiveRecords([...B.engine.getAllEnvelopes(), ...C.engine.getAllEnvelopes()], now + 100);
    await B.engine.receiveRecords([...A.engine.getAllEnvelopes(), ...C.engine.getAllEnvelopes()], now + 100);
    await C.engine.receiveRecords([...A.engine.getAllEnvelopes(), ...B.engine.getAllEnvelopes()], now + 100);

    // A removes C and rotates to epoch 2
    const { entropy: newEntropy } = await generateRecoveryPhrase();
    const { envelope: removeEnv } = await A.engine.removeDevice(C.device.deviceId, newEntropy, now + 200);
    expect(A.engine.epoch).toBe(2);

    // B receives removal record and automatically unwraps epoch 2 keys
    const bRes = await B.engine.receiveRecords([removeEnv], now + 300);
    expect(bRes.epochRotatedTo).toBe(2);
    expect(B.engine.epoch).toBe(2);

    // C creates a new record after removal (on epoch 1) -> A and B reject it
    const rogue = await C.engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'video' }], now + 400);
    const bRogue = await B.engine.receiveRecords(rogue, now + 500);
    expect(bRogue.accepted).toBe(0);
    expect(bRogue.rejected[0]!.reason).toMatch(/removed/i);

    // A writes under epoch 2 -> B decrypts and applies, C cannot decrypt
    const epoch2Rec = await A.engine.applyLocalChanges([{ path: 'config.defaultMode', value: 'news' }], now + 600);
    const bEpoch2 = await B.engine.receiveRecords(epoch2Rec, now + 700);
    expect(bEpoch2.applied[0]!.value).toBe('news');
    const cEpoch2 = await C.engine.receiveRecords(epoch2Rec, now + 700);
    expect(cEpoch2.accepted).toBe(0);
    expect(cEpoch2.rejected[0]!.reason).toMatch(/Unknown epoch/i);
  });

  it('compacts tombstones only after all active members acknowledge them', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    const B = await makePeer('B', groupKeys, now);

    await A.engine.receiveRecords(B.engine.getAllEnvelopes(), now + 100);
    await B.engine.receiveRecords(A.engine.getAllEnvelopes(), now + 100);

    const p = makeMembershipElementPath('config.judge.blockedDomains', 'temp.test');
    await A.engine.applyLocalChanges([{ path: p, value: true }], now + 200);
    await A.engine.applyLocalChanges([{ path: p, tombstone: true }], now + 300);

    // Before B acks, compaction removes nothing
    expect(await A.engine.compact()).toEqual({ removedEnvelopes: 0, removedTombstones: 0 });

    // B receives and A records B's ack vector
    await B.engine.receiveRecords(A.engine.missingRecordsFor(B.engine.getVersionVector()), now + 400);
    await A.engine.recordPeerAck(B.device.deviceId, B.engine.getVersionVector());

    const compacted = await A.engine.compact();
    expect(compacted.removedTombstones).toBe(1);
    expect(compacted.removedEnvelopes).toBeGreaterThanOrEqual(1);
    expect(A.engine.getRegisters()[p]).toBeUndefined();
  });

  it('resolves join conflicts in group, local, and merge modes', async () => {
    const groupKeys = await deriveGroupKeys(await importGroupSecret((await generateRecoveryPhrase()).entropy), 1);
    const now = 1_700_000_000_000;
    const A = await makePeer('A', groupKeys, now);
    await A.engine.applyLocalChanges(
      [
        { path: 'config.defaultMode', value: 'news' },
        { path: makeMembershipElementPath('config.judge.blockedDomains', 'group.test'), value: true },
      ],
      now + 100,
    );

    const B = await makePeer('B', groupKeys, now + 200);
    await B.engine.receiveRecords(A.engine.getAllEnvelopes(), now + 200);

    const localEntries = [
      { path: 'config.defaultMode', value: 'web' },
      { path: makeMembershipElementPath('config.judge.blockedDomains', 'local.test'), value: true },
    ];

    const mergeRes = await B.engine.resolveJoinConflict('merge', localEntries, now + 300);
    expect(mergeRes.emitted).toHaveLength(1); // local.test published, scalar stays group's 'news'
    expect(B.engine.getRegisters()['config.defaultMode']!.value).toBe('news');
    expect(B.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'local.test')]?.value).toBe(true);
    expect(B.engine.getRegisters()[makeMembershipElementPath('config.judge.blockedDomains', 'group.test')]?.value).toBe(true);
  });
});
