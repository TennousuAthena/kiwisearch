import {
  canonicalJson,
  fromBase64Url,
  toBase64Url,
  utf8Encode,
} from './encoding';
import {
  deriveDeviceId,
  deriveGroupKeys,
  importGroupSecret,
  importPeerSigningKey,
  memberCertificate,
  openRecordBody,
  sealRecordBody,
  signEd25519,
  MAX_RELAY_FRAME_BYTES,
  unwrapGroupEntropyFromPeer,
  verifyEd25519,
  verifyMemberCertificate,
  wrapGroupEntropyForPeer,
  type DeviceKeys,
  type GroupKeys,
  type MemberCertificateFields,
  type WrappedEpochSecret,
} from './crypto';
import {
  compareHlc,
  createHlc,
  isHlcDriftAcceptable,
  receiveHlc,
  tickHlc,
  type Hlc,
} from './hlc';
import {
  classifySyncPath,
  DEFAULT_SYNC_CATEGORIES,
  isCategoryEnabled,
  migrateRecordEntry,
  parseMembershipElementPath,
  validateAndClampSyncValue,
  type SyncCategory,
  type SyncCategorySettings,
} from './categories';

export type SyncRecordKind = 'set' | 'tombstone' | 'snapshot' | 'member-join' | 'member-remove' | 'epoch-rotate';

export interface SyncRecordEnvelope {
  deviceId: string;
  seq: number;
  epoch: number;
  hlc: Hlc;
  configVersion: number;
  kind: SyncRecordKind;
  signingPublic: string;
  nonce: string;
  ciphertext: string;
  signature: string;
}

export type SyncRecordBody =
  | { kind: 'set'; path: string; value: unknown }
  | { kind: 'tombstone'; path: string }
  | {
      kind: 'snapshot';
      entries: SyncSnapshotEntry[];
      members?: SyncMember[];
      coveredVector: VersionVector;
    }
  | {
      kind: 'member-join';
      deviceId: string;
      deviceName: string;
      signingPublic: string;
      agreementPublic: string;
      agreementSig?: string;
    }
  | {
      kind: 'member-remove';
      removedDeviceId: string;
      maxSeq: number;
      newEpoch: number;
      wrappedSecrets: WrappedEpochSecret[];
    }
  | {
      kind: 'epoch-rotate';
      newEpoch: number;
      wrappedSecrets: WrappedEpochSecret[];
    };

export interface SyncSnapshotEntry {
  path: string;
  value?: unknown;
  tombstone: boolean;
  hlc: Hlc;
  deviceId: string;
  seq: number;
  configVersion: number;
}

export interface SyncSnapshotRecords {
  records: SyncRecordEnvelope[];
  skippedPaths: string[];
}

export interface SyncMember {
  deviceId: string;
  deviceName: string;
  signingPublic: string;
  agreementPublic: string;
  agreementSig?: string;
  agreementAttested: boolean;
  agreementSeq: number;
  joinedAt: number;
  lastSeenAt: number;
  removedAt?: number;
  removedMaxSeq?: number;
}

export interface RegisterState {
  path: string;
  hlc: Hlc;
  deviceId: string;
  seq: number;
  tombstone: boolean;
  value: unknown;
  configVersion: number;
  category: SyncCategory | null;
}

export type VersionVector = Record<string, number>;

export interface LocalChangeInput {
  path: string;
  value?: unknown;
  tombstone?: boolean;
}

export interface AppliedChange {
  path: string;
  value?: unknown;
  tombstone: boolean;
  category: SyncCategory;
}

export interface ReceiveRecordsResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ deviceId: string; seq: number; reason: string }>;
  applied: AppliedChange[];
  epochRotatedTo?: number;
  groupSecret?: CryptoKey;
  removedSelf?: boolean;
}

export type JoinConflictMode = 'group' | 'local' | 'merge';

export interface PersistedSyncEngineState {
  epoch: number;
  seq: number;
  hlc: Hlc;
  configVersion: number;
  categories: SyncCategorySettings;
  versionVector: VersionVector;
  peerAcks: Record<string, VersionVector>;
  members: Record<string, SyncMember>;
  registers: Record<string, RegisterState>;
  excludedLocalEditClocks?: Record<string, Hlc>;
  recordLog: SyncRecordEnvelope[];
}

function envelopeAad(env: Pick<SyncRecordEnvelope, 'deviceId' | 'seq' | 'epoch' | 'hlc' | 'configVersion' | 'kind'>): string {
  return canonicalJson({
    deviceId: env.deviceId,
    seq: env.seq,
    epoch: env.epoch,
    hlc: env.hlc,
    configVersion: env.configVersion,
    kind: env.kind,
  });
}

function envelopeSignPayload(
  env: Omit<SyncRecordEnvelope, 'signature'>,
): Uint8Array<ArrayBuffer> {
  return utf8Encode(
    'kiwi-sync-record/v1:' +
      canonicalJson({
        deviceId: env.deviceId,
        seq: env.seq,
        epoch: env.epoch,
        hlc: env.hlc,
        configVersion: env.configVersion,
        kind: env.kind,
        signingPublic: env.signingPublic,
        nonce: env.nonce,
        ciphertext: env.ciphertext,
      }),
  );
}

export class SyncEngine {
  private readonly device: DeviceKeys;
  private readonly deviceName: string;
  private readonly epochKeys = new Map<number, GroupKeys>();
  private currentEpoch: number;
  private seq: number;
  private hlc: Hlc;
  private configVersion: number;
  private categories: SyncCategorySettings;
  private versionVector: VersionVector;
  private peerAcks: Record<string, VersionVector>;
  private members: Record<string, SyncMember>;
  private registers: Record<string, RegisterState>;
  private readonly excludedLocalEditClocks = new Map<string, Hlc>();
  private recordLog: Map<string, SyncRecordEnvelope>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(params: {
    device: DeviceKeys;
    deviceName: string;
    groupKeys: GroupKeys;
    configVersion: number;
    categories?: SyncCategorySettings;
    persisted?: PersistedSyncEngineState;
    nowMs?: number;
  }) {
    this.device = params.device;
    this.deviceName = params.deviceName;
    this.epochKeys.set(params.groupKeys.epoch, params.groupKeys);
    this.configVersion = params.configVersion;

    if (params.persisted) {
      this.currentEpoch = params.persisted.epoch;
      this.seq = params.persisted.seq;
      this.hlc = { ...params.persisted.hlc };
      this.categories = { ...DEFAULT_SYNC_CATEGORIES, ...params.persisted.categories };
      this.versionVector = { ...params.persisted.versionVector };
      this.peerAcks = structuredClone(params.persisted.peerAcks);
      this.members = Object.fromEntries(
        Object.entries(structuredClone(params.persisted.members)).map(([deviceId, member]) => [
          deviceId,
          {
            ...member,
            agreementSig: member.agreementSig ?? '',
            agreementAttested: member.agreementAttested ?? true,
            agreementSeq: member.agreementSeq ?? 0,
          },
        ]),
      );
      const ownMember = this.members[this.device.deviceId];
      if (ownMember && this.device.agreementSig) {
        ownMember.agreementSig = this.device.agreementSig;
      }
      this.registers = structuredClone(params.persisted.registers);
      for (const [path, clock] of Object.entries(params.persisted.excludedLocalEditClocks ?? {})) {
        this.excludedLocalEditClocks.set(path, { ...clock });
      }
      this.recordLog = new Map(params.persisted.recordLog.map((r) => [this.recordKeyId(r.deviceId, r.seq), r]));
    } else {
      const now = params.nowMs ?? Date.now();
      this.currentEpoch = params.groupKeys.epoch;
      this.seq = 0;
      this.hlc = createHlc(params.device.deviceId, now);
      this.categories = { ...DEFAULT_SYNC_CATEGORIES, ...params.categories };
      this.versionVector = {};
      this.peerAcks = {};
      this.members = {
        [params.device.deviceId]: {
          deviceId: params.device.deviceId,
          deviceName: params.deviceName,
          signingPublic: toBase64Url(params.device.signingPublicRaw),
          agreementPublic: toBase64Url(params.device.agreementPublicRaw),
          agreementSig: params.device.agreementSig ?? '',
          agreementAttested: false,
          agreementSeq: 0,
          joinedAt: now,
          lastSeenAt: now,
        },
      };
      this.registers = {};
      this.recordLog = new Map();
    }
  }

  private recordKeyId(deviceId: string, seq: number): string {
    return `${deviceId}:${seq}`;
  }

  private async ensureLocalMemberCertificate(): Promise<string> {
    const signingPublic = toBase64Url(this.device.signingPublicRaw);
    const agreementPublic = toBase64Url(this.device.agreementPublicRaw);
    const fields: MemberCertificateFields = {
      deviceId: this.device.deviceId,
      signingPublic,
      agreementPublic,
      agreementSig: this.device.agreementSig ?? '',
    };
    const agreementSig =
      (await verifyMemberCertificate(fields)) ? fields.agreementSig : await memberCertificate(this.device);
    this.device.agreementSig = agreementSig;
    const existing = this.members[this.device.deviceId];
    this.members[this.device.deviceId] = {
      deviceId: this.device.deviceId,
      deviceName: this.deviceName,
      signingPublic,
      agreementPublic,
      agreementSig,
      agreementAttested: true,
      agreementSeq: existing?.agreementSeq ?? 0,
      joinedAt: existing?.joinedAt ?? this.hlc.ms,
      lastSeenAt: Math.max(existing?.lastSeenAt ?? this.hlc.ms, this.hlc.ms),
      removedAt: existing?.removedAt,
      removedMaxSeq: existing?.removedMaxSeq,
    };
    return agreementSig;
  }

  private withMutationLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(work, work);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get deviceId(): string {
    return this.device.deviceId;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  getGroupKeys(epoch = this.currentEpoch): GroupKeys | undefined {
    return this.epochKeys.get(epoch);
  }

  registerEpochKeys(keys: GroupKeys): Promise<void> {
    return this.withMutationLock(async () => this.registerEpochKeysLocked(keys));
  }

  private registerEpochKeysLocked(keys: GroupKeys): void {
    this.epochKeys.set(keys.epoch, keys);
    if (keys.epoch > this.currentEpoch) {
      this.currentEpoch = keys.epoch;
    }
  }

  getCategories(): SyncCategorySettings {
    return { ...this.categories };
  }

  setCategories(next: Partial<SyncCategorySettings>): Promise<SyncCategorySettings> {
    return this.withMutationLock(async () => this.setCategoriesLocked(next));
  }

  private setCategoriesLocked(next: Partial<SyncCategorySettings>): SyncCategorySettings {
    this.categories = { ...this.categories, ...next };
    return this.getCategories();
  }

  reconcileIncludedRegisters(
    previousCategories: SyncCategorySettings,
    readLocalChanges: (paths: string[]) => Promise<LocalChangeInput[]>,
    initialJoinPending: boolean,
  ): Promise<{ reclassified: boolean; toApplyLocally: AppliedChange[]; emitted: SyncRecordEnvelope[] }> {
    return this.withMutationLock(async () => {
      let reclassified = false;
      const toApplyLocally: AppliedChange[] = [];
      const localWinners = new Map<string, Hlc>();
      const considered = new Set<string>();
      for (const register of Object.values(this.registers)) {
        const previousCategory = register.category;
        const category = classifySyncPath(register.path);
        if (previousCategory !== category) {
          register.category = category;
          reclassified = true;
        }
        const searxngOriginMayNowSync = register.path === 'config.sources.searxng.baseUrl' &&
          !previousCategories.keys && this.categories.keys;
        if (
          initialJoinPending || category === null || !isCategoryEnabled(this.categories, category) ||
          (isCategoryEnabled(previousCategories, previousCategory) && !searxngOriginMayNowSync)
        ) continue;
        considered.add(register.path);
        const localClock = this.excludedLocalEditClocks.get(register.path);
        if (localClock && compareHlc(localClock, register.hlc) > 0) {
          localWinners.set(register.path, localClock);
        } else if (register.deviceId !== this.device.deviceId) {
          toApplyLocally.push({ path: register.path, value: register.value, tombstone: register.tombstone, category });
        }
      }
      if (!initialJoinPending) {
        for (const [path, clock] of this.excludedLocalEditClocks) {
          if (this.registers[path]) continue;
          const category = classifySyncPath(path);
          if (isCategoryEnabled(this.categories, category) && !isCategoryEnabled(previousCategories, category)) {
            considered.add(path);
            localWinners.set(path, clock);
          }
        }
      }
      const emitted = localWinners.size
        ? await this.applyLocalChangesLocked(await readLocalChanges([...localWinners.keys()]), Date.now(), localWinners)
        : [];
      for (const path of considered) this.excludedLocalEditClocks.delete(path);
      return { reclassified, toApplyLocally, emitted };
    });
  }

  getVersionVector(): VersionVector {
    return { ...this.versionVector };
  }

  getMembers(): SyncMember[] {
    return Object.values(this.members).map((m) => ({ ...m }));
  }

  getActiveMembers(): SyncMember[] {
    return Object.values(this.members)
      .filter((m) => m.removedAt === undefined)
      .map((m) => ({ ...m }));
  }

  getRegisters(): Record<string, RegisterState> {
    return structuredClone(this.registers);
  }

  getAllEnvelopes(): SyncRecordEnvelope[] {
    return [...this.recordLog.values()];
  }

  getMemberJoinEpoch(deviceId: string): number | undefined {
    return [...this.recordLog.values()]
      .filter((record) => record.deviceId === deviceId && record.kind === 'member-join')
      .sort((a, b) => b.seq - a.seq)[0]?.epoch;
  }

  hasAcceptedRecords(): boolean {
    return [...this.recordLog.values()].some((record) => record.deviceId !== this.device.deviceId);
  }

  adoptCoveredVector(coveredVector: VersionVector): Promise<void> {
    return this.withMutationLock(async () => this.adoptCoveredVectorLocked(coveredVector));
  }

  private adoptCoveredVectorLocked(coveredVector: VersionVector): void {
    for (const [deviceId, seq] of Object.entries(coveredVector)) {
      if (Number.isInteger(seq) && seq >= 0) {
        this.versionVector[deviceId] = Math.max(this.versionVector[deviceId] ?? 0, seq);
        this.advanceVersionVector(deviceId);
      }
    }
  }

  async createSnapshotRecords(nowMs = Date.now()): Promise<SyncSnapshotRecords> {
    return this.withMutationLock(() => this.createSnapshotRecordsLocked(nowMs));
  }

  private async createSnapshotRecordsLocked(nowMs: number): Promise<SyncSnapshotRecords> {
    await this.ensureLocalMemberCertificate();
    const coveredVector = this.getVersionVector();
    const entries: SyncSnapshotEntry[] = Object.values(this.registers).map((register) => ({
      path: register.path,
      ...(register.value === undefined ? {} : { value: register.value }),
      tombstone: register.tombstone,
      hlc: register.hlc,
      deviceId: register.deviceId,
      seq: register.seq,
      configVersion: register.configVersion,
    }));
    const members = this.getMembers().map((member) => ({
      ...member,
      deviceName: member.deviceName.slice(0, 128),
    }));
    const items = [
      ...members.map((value) => ({ type: 'member' as const, value })),
      ...entries.map((value) => ({ type: 'entry' as const, value })),
    ];
    const records: SyncRecordEnvelope[] = [];
    const skippedPaths: string[] = [];
    let currentEntries: SyncSnapshotEntry[] = [];
    let currentMembers: SyncMember[] = [];
    let currentEnvelope: SyncRecordEnvelope | null = null;
    const bodyFor = (chunkEntries: SyncSnapshotEntry[], chunkMembers: SyncMember[]): SyncRecordBody => ({
      kind: 'snapshot',
      entries: chunkEntries,
      members: chunkMembers,
      coveredVector,
    });
    const envelopeFor = (chunkEntries: SyncSnapshotEntry[], chunkMembers: SyncMember[]) =>
      this.createEnvelope('snapshot', bodyFor(chunkEntries, chunkMembers), nowMs);
    const commitCurrent = (): void => {
      if (!currentEnvelope) return;
      this.commitEnvelope(currentEnvelope);
      records.push(currentEnvelope);
      currentEntries = [];
      currentMembers = [];
      currentEnvelope = null;
    };
    for (const item of items) {
      const nextEntries = item.type === 'entry' ? [...currentEntries, item.value] : currentEntries;
      const nextMembers = item.type === 'member' ? [...currentMembers, item.value] : currentMembers;
      const candidate = await envelopeFor(nextEntries, nextMembers);
      if (utf8Encode(JSON.stringify(candidate)).byteLength <= MAX_RELAY_FRAME_BYTES) {
        currentEntries = nextEntries;
        currentMembers = nextMembers;
        currentEnvelope = candidate;
        continue;
      }

      if (currentEnvelope) commitCurrent();
      const singleEntry = item.type === 'entry' ? [item.value] : [];
      const singleMember = item.type === 'member' ? [item.value] : [];
      const single = await envelopeFor(singleEntry, singleMember);
      if (utf8Encode(JSON.stringify(single)).byteLength <= MAX_RELAY_FRAME_BYTES) {
        currentEntries = singleEntry;
        currentMembers = singleMember;
        currentEnvelope = single;
      } else if (item.type === 'entry') {
        skippedPaths.push(item.value.path);
      } else {
        throw new Error(`Snapshot member cannot fit in a ${MAX_RELAY_FRAME_BYTES} byte record`);
      }
    }
    if (currentEnvelope) commitCurrent();
    if (!records.length) {
      const empty = await envelopeFor([], []);
      if (utf8Encode(JSON.stringify(empty)).byteLength > MAX_RELAY_FRAME_BYTES) {
        throw new Error(`Empty snapshot exceeds ${MAX_RELAY_FRAME_BYTES} byte record limit`);
      }
      this.commitEnvelope(empty);
      records.push(empty);
    }
    return { records, skippedPaths };
  }

  exportState(): PersistedSyncEngineState {
    return {
      epoch: this.currentEpoch,
      seq: this.seq,
      hlc: { ...this.hlc },
      configVersion: this.configVersion,
      categories: { ...this.categories },
      versionVector: { ...this.versionVector },
      peerAcks: structuredClone(this.peerAcks),
      members: structuredClone(this.members),
      registers: structuredClone(this.registers),
      excludedLocalEditClocks: structuredClone(Object.fromEntries(this.excludedLocalEditClocks)),
      recordLog: [...this.recordLog.values()],
    };
  }

  recordPeerAck(peerDeviceId: string, remoteVector: VersionVector): Promise<void> {
    return this.withMutationLock(async () => this.recordPeerAckLocked(peerDeviceId, remoteVector));
  }

  private recordPeerAckLocked(peerDeviceId: string, remoteVector: VersionVector): void {
    const existing = this.peerAcks[peerDeviceId] ?? {};
    const merged: VersionVector = { ...existing };
    for (const [dev, seq] of Object.entries(remoteVector)) {
      if (typeof seq === 'number' && seq > (merged[dev] ?? 0)) {
        merged[dev] = seq;
      }
    }
    this.peerAcks[peerDeviceId] = merged;
    const member = this.members[peerDeviceId];
    if (member) member.lastSeenAt = Date.now();
  }

  missingRecordsFor(remoteVector: VersionVector): SyncRecordEnvelope[] {
    const missing: SyncRecordEnvelope[] = [];
    for (const env of this.recordLog.values()) {
      const acked = remoteVector[env.deviceId] ?? 0;
      if (env.seq > acked) {
        missing.push(env);
      }
    }
    missing.sort((a, b) => (a.deviceId === b.deviceId ? a.seq - b.seq : a.deviceId < b.deviceId ? -1 : 1));
    return missing;
  }

  private async validateSnapshotMember(value: unknown): Promise<SyncMember | null> {
    if (!value || typeof value !== 'object') return null;
    const member = value as SyncMember;
    if (
      typeof member.deviceId !== 'string' ||
      !member.deviceId ||
      typeof member.deviceName !== 'string' ||
      typeof member.signingPublic !== 'string' ||
      typeof member.agreementPublic !== 'string' ||
      !Number.isFinite(member.joinedAt) ||
      !Number.isFinite(member.lastSeenAt) ||
      (member.agreementSeq !== undefined && (!Number.isInteger(member.agreementSeq) || member.agreementSeq < 0)) ||
      (member.removedAt !== undefined && !Number.isFinite(member.removedAt)) ||
      (member.removedMaxSeq !== undefined && (!Number.isInteger(member.removedMaxSeq) || member.removedMaxSeq < 0))
    ) {
      return null;
    }

    const existing = this.members[member.deviceId];
    const agreementSeq = member.agreementSeq ?? 0;
    const agreementSig = typeof member.agreementSig === 'string' ? member.agreementSig : '';
    const withSequence = { ...member, agreementSeq };
    const keylessRemoval =
      member.removedAt !== undefined &&
      member.signingPublic === '' &&
      member.agreementPublic === '';
    if (keylessRemoval) return { ...withSequence, agreementSig, agreementAttested: false };
    if (!member.signingPublic || !member.agreementPublic) return null;

    try {
      const signingPublic = fromBase64Url(member.signingPublic);
      const agreementPublic = fromBase64Url(member.agreementPublic);
      if (
        signingPublic.byteLength !== 32 ||
        agreementPublic.byteLength !== 32 ||
        (await deriveDeviceId(signingPublic)) !== member.deviceId ||
        (existing?.signingPublic && existing.signingPublic !== member.signingPublic) ||
        (existing?.agreementAttested && existing.agreementPublic !== member.agreementPublic)
      ) {
        return null;
      }
    } catch {
      return null;
    }
    const agreementAttested = agreementSig
      ? await verifyMemberCertificate({
          deviceId: member.deviceId,
          signingPublic: member.signingPublic,
          agreementPublic: member.agreementPublic,
          agreementSig,
        })
      : false;
    return {
      ...withSequence,
      agreementSig: agreementAttested ? agreementSig : '',
      agreementAttested,
      agreementSeq: agreementAttested ? agreementSeq : 0,
    };
  }

  async createMemberJoinRecord(nowMs = Date.now()): Promise<SyncRecordEnvelope> {
    return this.withMutationLock(() => this.createMemberJoinRecordLocked(nowMs));
  }

  private async createMemberJoinRecordLocked(nowMs: number): Promise<SyncRecordEnvelope> {
    const agreementSig = await this.ensureLocalMemberCertificate();
    const envelope = await this.appendEnvelope(
      'member-join',
      {
        kind: 'member-join',
        deviceId: this.device.deviceId,
        deviceName: this.deviceName,
        signingPublic: toBase64Url(this.device.signingPublicRaw),
        agreementPublic: toBase64Url(this.device.agreementPublicRaw),
        agreementSig,
      },
      nowMs,
    );
    this.members[this.device.deviceId]!.agreementSeq = envelope.seq;
    return envelope;
  }

  async applyLocalChanges(changes: readonly LocalChangeInput[], nowMs = Date.now()): Promise<SyncRecordEnvelope[]> {
    return this.withMutationLock(() => this.applyLocalChangesLocked(changes, nowMs));
  }

  private async applyLocalChangesLocked(
    changes: readonly LocalChangeInput[],
    nowMs: number,
    deferredClocks?: ReadonlyMap<string, Hlc>,
  ): Promise<SyncRecordEnvelope[]> {
    const emitted: SyncRecordEnvelope[] = [];
    for (const change of changes) {
      const category = classifySyncPath(change.path);
      if (!category) continue;
      if (!isCategoryEnabled(this.categories, category)) {
        this.hlc = tickHlc(this.hlc, this.device.deviceId, nowMs);
        this.excludedLocalEditClocks.set(change.path, this.hlc);
        continue;
      }
      this.excludedLocalEditClocks.delete(change.path);
      const deferredClock = deferredClocks?.get(change.path);
      const isTombstone = Boolean(change.tombstone);
      if (!isTombstone) {
        const checked = validateAndClampSyncValue(change.path, change.value);
        if (!checked.ok) continue;
        const env = await this.appendEnvelope(
          'set',
          { kind: 'set', path: change.path, value: checked.value },
          nowMs,
          deferredClock,
        );
        this.registers[change.path] = {
          path: change.path,
          hlc: env.hlc,
          deviceId: env.deviceId,
          seq: env.seq,
          tombstone: false,
          value: checked.value,
          configVersion: this.configVersion,
          category,
        };
        emitted.push(env);
      } else {
        const env = await this.appendEnvelope('tombstone', { kind: 'tombstone', path: change.path }, nowMs, deferredClock);
        this.registers[change.path] = {
          path: change.path,
          hlc: env.hlc,
          deviceId: env.deviceId,
          seq: env.seq,
          tombstone: true,
          value: undefined,
          configVersion: this.configVersion,
          category,
        };
        emitted.push(env);
      }
    }
    return emitted;
  }

  async receiveRecords(
    envelopes: readonly SyncRecordEnvelope[],
    nowMs = Date.now(),
  ): Promise<ReceiveRecordsResult> {
    return this.withMutationLock(() => this.receiveRecordsLocked(envelopes, nowMs));
  }

  private async receiveRecordsLocked(
    envelopes: readonly SyncRecordEnvelope[],
    nowMs: number,
  ): Promise<ReceiveRecordsResult> {
    const result: ReceiveRecordsResult = {
      accepted: 0,
      duplicates: 0,
      rejected: [],
      applied: [],
    };

    for (const env of envelopes) {
      const keyId = this.recordKeyId(env.deviceId, env.seq);
      if (this.recordLog.has(keyId)) {
        result.duplicates += 1;
        continue;
      }

      if (!Number.isInteger(env.seq) || env.seq < 1) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Invalid sequence number' });
        continue;
      }

      if (!isHlcDriftAcceptable(env.hlc, nowMs)) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Remote HLC exceeds 24h drift limit' });
        continue;
      }

      // Check removed member seq cap before accepting anything further from that device.
      const existingMember = this.members[env.deviceId];
      if (
        existingMember?.removedAt !== undefined &&
        existingMember.removedMaxSeq !== undefined &&
        env.seq > existingMember.removedMaxSeq
      ) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Device has been removed' });
        continue;
      }

      // Verify deviceId matches signingPublic and verify Ed25519 signature.
      let expectedDeviceId: string;
      try {
        expectedDeviceId = await deriveDeviceId(fromBase64Url(env.signingPublic));
      } catch {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Malformed signingPublic' });
        continue;
      }
      if (expectedDeviceId !== env.deviceId) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'deviceId mismatch' });
        continue;
      }
      if (existingMember && existingMember.signingPublic !== env.signingPublic) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Signing key mismatch for known device' });
        continue;
      }

      let sigValid = false;
      try {
        const pubKey = await importPeerSigningKey(env.signingPublic);
        const { signature, ...unsigned } = env;
        sigValid = await verifyEd25519(pubKey, fromBase64Url(signature), envelopeSignPayload(unsigned));
      } catch {
        sigValid = false;
      }
      if (!sigValid) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Invalid Ed25519 signature' });
        continue;
      }

      const keys = this.epochKeys.get(env.epoch);
      if (!keys) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: `Unknown epoch ${env.epoch}` });
        continue;
      }

      let body: SyncRecordBody;
      try {
        body = await openRecordBody<SyncRecordBody>(keys.recordKey, envelopeAad(env), env.nonce, env.ciphertext);
      } catch {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Failed to decrypt record body' });
        continue;
      }

      if (body.kind !== env.kind) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Record kind mismatch' });
        continue;
      }
      let memberJoinAgreementSig = '';
      if (body.kind === 'snapshot' && (!Array.isArray(body.entries) || (body.members !== undefined && !Array.isArray(body.members)))) {
        result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Invalid snapshot body' });
        continue;
      }
      if (body.kind === 'snapshot') {
        let invalidMember = false;
        const validatedMembers: SyncMember[] = [];
        for (const member of body.members ?? []) {
          const validated = await this.validateSnapshotMember(member);
          if (!validated) {
            invalidMember = true;
            break;
          }
          validatedMembers.push(validated);
        }
        if (invalidMember) {
          result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Invalid snapshot member identity' });
          continue;
        }
        body.members = validatedMembers;
      }

      if (body.kind === 'member-join') {
        if (body.deviceId !== env.deviceId || body.signingPublic !== env.signingPublic) {
          result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Member join identity mismatch' });
          continue;
        }
        try {
          if (fromBase64Url(body.agreementPublic).byteLength !== 32) throw new Error('Invalid agreement key');
        } catch {
          result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Invalid member agreement key' });
          continue;
        }
        if (
          typeof body.agreementSig === 'string' &&
          (await verifyMemberCertificate({
            deviceId: body.deviceId,
            signingPublic: body.signingPublic,
            agreementPublic: body.agreementPublic,
            agreementSig: body.agreementSig,
          }))
        ) {
          memberJoinAgreementSig = body.agreementSig;
        }
      }

      // Accept record into log and advance HLC & version vector.
      this.hlc = receiveHlc(this.hlc, env.hlc, this.device.deviceId, nowMs);
      this.recordLog.set(keyId, env);
      this.advanceVersionVector(env.deviceId);
      result.accepted += 1;

      if (body.kind === 'member-join') {
        const prev = this.members[body.deviceId];
        const previousAgreementSeq = prev?.agreementSeq ?? 0;
        const sameAgreementKey = prev?.agreementPublic === body.agreementPublic;
        const updateAgreementKey = !prev || env.seq > previousAgreementSeq;
        const mayUseIncomingCertificate = updateAgreementKey || sameAgreementKey;
        this.members[body.deviceId] = {
          deviceId: body.deviceId,
          deviceName: body.deviceName,
          signingPublic: body.signingPublic,
          agreementPublic: updateAgreementKey ? body.agreementPublic : prev!.agreementPublic,
          agreementSig: mayUseIncomingCertificate
            ? memberJoinAgreementSig || (sameAgreementKey ? prev?.agreementSig ?? '' : '')
            : prev?.agreementSig ?? '',
          agreementAttested: Boolean(prev?.agreementAttested || mayUseIncomingCertificate),
          agreementSeq: updateAgreementKey ? env.seq : previousAgreementSeq,
          joinedAt: prev?.joinedAt ?? env.hlc.ms,
          lastSeenAt: nowMs,
          removedAt: prev?.removedAt,
          removedMaxSeq: prev?.removedMaxSeq,
        };
      } else if (body.kind === 'member-remove') {
        const target = this.members[body.removedDeviceId];
        if (target) {
          target.removedAt = env.hlc.ms;
          target.removedMaxSeq = body.maxSeq;
        } else {
          this.members[body.removedDeviceId] = {
            deviceId: body.removedDeviceId,
            deviceName: body.removedDeviceId,
            signingPublic: '',
            agreementPublic: '',
            agreementSig: '',
            agreementAttested: false,
            agreementSeq: 0,
            joinedAt: env.hlc.ms,
            lastSeenAt: env.hlc.ms,
            removedAt: env.hlc.ms,
            removedMaxSeq: body.maxSeq,
          };
        }
        if (body.removedDeviceId === this.device.deviceId) {
          result.removedSelf = true;
        } else {
          const rotated = await this.tryUnwrapEpoch(body.newEpoch, body.wrappedSecrets);
          if (rotated) {
            result.epochRotatedTo = body.newEpoch;
            result.groupSecret = rotated.secret;
          }
        }
      } else if (body.kind === 'epoch-rotate') {
        const rotated = await this.tryUnwrapEpoch(body.newEpoch, body.wrappedSecrets);
        if (rotated) {
          result.epochRotatedTo = body.newEpoch;
          result.groupSecret = rotated.secret;
        }
      } else if (body.kind === 'snapshot') {
        for (const member of body.members ?? []) {
          const existing = this.members[member.deviceId];
          const removedAt = existing?.removedAt ?? member.removedAt;
          const existingAttested = Boolean(existing?.agreementAttested);
          const existingAgreementSeq = existing?.agreementSeq ?? 0;
          const sameAgreementKey = existing?.agreementPublic === member.agreementPublic;
          const applyIncomingAgreementKey = !existing || member.agreementSeq > existingAgreementSeq;
          const mayUseIncomingMember = applyIncomingAgreementKey || sameAgreementKey;
          const incomingAgreementSig = member.agreementAttested ? member.agreementSig ?? '' : '';
          this.members[member.deviceId] = {
            ...member,
            signingPublic: existing?.signingPublic || member.signingPublic,
            agreementPublic: applyIncomingAgreementKey ? member.agreementPublic : existing!.agreementPublic,
            agreementSig: mayUseIncomingMember
              ? incomingAgreementSig || (sameAgreementKey ? existing?.agreementSig ?? '' : '')
              : existing?.agreementSig ?? '',
            agreementAttested: existingAttested || (mayUseIncomingMember && member.agreementAttested),
            agreementSeq: Math.max(existingAgreementSeq, member.agreementSeq),
            joinedAt: Math.min(existing?.joinedAt ?? member.joinedAt, member.joinedAt),
            lastSeenAt: Math.max(existing?.lastSeenAt ?? member.lastSeenAt, member.lastSeenAt),
            removedAt,
            removedMaxSeq:
              removedAt === undefined
                ? undefined
                : Math.max(existing?.removedMaxSeq ?? 0, member.removedMaxSeq ?? 0),
          };
        }
        for (const entry of body.entries) {
          if (
            !entry ||
            typeof entry.path !== 'string' ||
            typeof entry.deviceId !== 'string' ||
            !Number.isInteger(entry.seq) ||
            entry.seq < 1 ||
            !Number.isInteger(entry.configVersion) ||
            entry.hlc?.deviceId !== entry.deviceId ||
            !isHlcDriftAcceptable(entry.hlc, nowMs)
          ) {
            result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: 'Invalid snapshot entry' });
            continue;
          }
          const migrated = migrateRecordEntry(
            { path: entry.path, value: entry.value, tombstone: entry.tombstone },
            entry.configVersion,
            this.configVersion,
          );
          const category = classifySyncPath(migrated.path);
          const existing = this.registers[migrated.path];
          if (existing && compareHlc(entry.hlc, existing.hlc) <= 0) continue;
          if (!migrated.tombstone && category !== null) {
            const checked = validateAndClampSyncValue(migrated.path, migrated.value);
            if (!checked.ok) {
              result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: checked.reason });
              continue;
            }
            migrated.value = checked.value;
          }
          this.registers[migrated.path] = {
            path: migrated.path,
            hlc: entry.hlc,
            deviceId: entry.deviceId,
            seq: entry.seq,
            tombstone: Boolean(migrated.tombstone),
            value: migrated.value,
            configVersion: entry.configVersion,
            category,
          };
          if (category !== null && isCategoryEnabled(this.categories, category)) {
            result.applied.push({
              path: migrated.path,
              value: migrated.value,
              tombstone: Boolean(migrated.tombstone),
              category,
            });
          }
        }
        this.adoptCoveredVectorLocked(body.coveredVector);
      } else if (body.kind === 'set' || body.kind === 'tombstone') {
        const migrated = migrateRecordEntry(
          {
            path: body.path,
            value: body.kind === 'set' ? body.value : undefined,
            tombstone: body.kind === 'tombstone',
          },
          env.configVersion,
          this.configVersion,
        );
        const category = classifySyncPath(migrated.path);
        const existing = this.registers[migrated.path];
        if (existing && compareHlc(env.hlc, existing.hlc) <= 0) {
          // Existing register has a newer or equal HLC; keep log entry for forwarding, do not overwrite.
          continue;
        }
        if (!migrated.tombstone && category !== null) {
          const checked = validateAndClampSyncValue(migrated.path, migrated.value);
          if (!checked.ok) {
            result.rejected.push({ deviceId: env.deviceId, seq: env.seq, reason: checked.reason });
            continue;
          }
          migrated.value = checked.value;
        }
        this.registers[migrated.path] = {
          path: migrated.path,
          hlc: env.hlc,
          deviceId: env.deviceId,
          seq: env.seq,
          tombstone: Boolean(migrated.tombstone),
          value: migrated.value,
          configVersion: env.configVersion,
          category,
        };
        // Unknown paths (category === null) are kept in registers & recordLog for forwarding, never applied locally.
        // Disabled categories (e.g. keys=false by default) are also never applied locally.
        if (category !== null && isCategoryEnabled(this.categories, category)) {
          result.applied.push({
            path: migrated.path,
            value: migrated.value,
            tombstone: Boolean(migrated.tombstone),
            category,
          });
        }
      }
    }

    return result;
  }

  /**
   * Removes a device from the group, rotates to epoch + 1 with newEntropy,
   * and wraps newEntropy for every remaining active member using X25519.
   */
  async removeDevice(
    removedDeviceId: string,
    newEntropy: Uint8Array,
    nowMs = Date.now(),
  ): Promise<{ envelope: SyncRecordEnvelope; newGroupKeys: GroupKeys }> {
    return this.withMutationLock(() => this.removeDeviceLocked(removedDeviceId, newEntropy, nowMs));
  }

  private async removeDeviceLocked(
    removedDeviceId: string,
    newEntropy: Uint8Array,
    nowMs: number,
  ): Promise<{ envelope: SyncRecordEnvelope; newGroupKeys: GroupKeys }> {
    if (removedDeviceId === this.device.deviceId) {
      throw new Error('Cannot remove the current device via removeDevice; use leave instead');
    }
    const maxSeq = this.versionVector[removedDeviceId] ?? 0;
    const newEpoch = this.currentEpoch + 1;
    const wrappedSecrets = await this.wrapForActiveMembers(newEpoch, newEntropy, removedDeviceId);

    const envelope = await this.appendEnvelope(
      'member-remove',
      {
        kind: 'member-remove',
        removedDeviceId,
        maxSeq,
        newEpoch,
        wrappedSecrets,
      },
      nowMs,
    );

    const target = this.members[removedDeviceId];
    if (target) {
      target.removedAt = nowMs;
      target.removedMaxSeq = maxSeq;
    }

    const secret = await importGroupSecret(newEntropy);
    const newGroupKeys = await deriveGroupKeys(secret, newEpoch);
    this.registerEpochKeysLocked(newGroupKeys);

    return { envelope, newGroupKeys };
  }

  /**
   * Rotates the recovery phrase / epoch without removing any active member.
   */
  async rotatePhrase(
    newEntropy: Uint8Array,
    nowMs = Date.now(),
  ): Promise<{ envelope: SyncRecordEnvelope; newGroupKeys: GroupKeys }> {
    return this.withMutationLock(() => this.rotatePhraseLocked(newEntropy, nowMs));
  }

  private async rotatePhraseLocked(
    newEntropy: Uint8Array,
    nowMs: number,
  ): Promise<{ envelope: SyncRecordEnvelope; newGroupKeys: GroupKeys }> {
    const newEpoch = this.currentEpoch + 1;
    const wrappedSecrets = await this.wrapForActiveMembers(newEpoch, newEntropy);

    const envelope = await this.appendEnvelope(
      'epoch-rotate',
      {
        kind: 'epoch-rotate',
        newEpoch,
        wrappedSecrets,
      },
      nowMs,
    );

    const secret = await importGroupSecret(newEntropy);
    const newGroupKeys = await deriveGroupKeys(secret, newEpoch);
    this.registerEpochKeysLocked(newGroupKeys);

    return { envelope, newGroupKeys };
  }

  /**
   * Compacts superseded record envelopes and tombstones once every active member
   * has acknowledged up to the winning/tombstone (deviceId, seq).
   */
  compact(): Promise<{ removedEnvelopes: number; removedTombstones: number }> {
    return this.withMutationLock(async () => this.compactLocked());
  }

  private compactLocked(): { removedEnvelopes: number; removedTombstones: number } {
    const activeMemberIds = this.getActiveMembers()
      .map((m) => m.deviceId)
      .filter((id) => id !== this.device.deviceId);

    if (activeMemberIds.length === 0) {
      return { removedEnvelopes: 0, removedTombstones: 0 };
    }

    const isAckedByAll = (deviceId: string, seq: number): boolean => {
      for (const peerId of activeMemberIds) {
        const peerVec = this.peerAcks[peerId];
        if (!peerVec || (peerVec[deviceId] ?? 0) < seq) return false;
      }
      return true;
    };

    const winningKeys = new Set<string>();
    let removedTombstones = 0;

    for (const [path, reg] of Object.entries(this.registers)) {
      if (reg.tombstone && isCategoryEnabled(this.categories, reg.category) && isAckedByAll(reg.deviceId, reg.seq)) {
        delete this.registers[path];
        removedTombstones += 1;
      } else {
        winningKeys.add(this.recordKeyId(reg.deviceId, reg.seq));
      }
    }

    let removedEnvelopes = 0;
    for (const [keyId, env] of this.recordLog) {
      if (env.kind !== 'set' && env.kind !== 'tombstone') continue;
      if (winningKeys.has(keyId)) continue;
      if (isAckedByAll(env.deviceId, env.seq)) {
        this.recordLog.delete(keyId);
        removedEnvelopes += 1;
      }
    }

    return { removedEnvelopes, removedTombstones };
  }

  /**
   * Resolves initial settings when a device with existing local settings joins a group:
   * - 'group' (default): apply group registers to local device, emit nothing
   * - 'local': publish local entries with fresh HLCs so local values win
   * - 'merge': keep group scalar values, publish local membership additions not in group, apply group registers
   */
  async resolveJoinConflict(
    mode: JoinConflictMode,
    localEntries: readonly LocalChangeInput[],
    nowMs = Date.now(),
  ): Promise<{ toApplyLocally: AppliedChange[]; emitted: SyncRecordEnvelope[] }> {
    return this.withMutationLock(() => this.resolveJoinConflictLocked(mode, localEntries, nowMs));
  }

  private async resolveJoinConflictLocked(
    mode: JoinConflictMode,
    localEntries: readonly LocalChangeInput[],
    nowMs: number,
  ): Promise<{ toApplyLocally: AppliedChange[]; emitted: SyncRecordEnvelope[] }> {
    const groupApplied: AppliedChange[] = [];
    for (const reg of Object.values(this.registers)) {
      if (reg.category === null || !isCategoryEnabled(this.categories, reg.category)) continue;
      groupApplied.push({
        path: reg.path,
        value: reg.value,
        tombstone: reg.tombstone,
        category: reg.category,
      });
    }

    if (mode === 'group') {
      return { toApplyLocally: groupApplied, emitted: [] };
    }

    if (mode === 'local') {
      const emitted = await this.applyLocalChangesLocked(localEntries, nowMs);
      return { toApplyLocally: [], emitted };
    }

    // 'merge': union membership sets + keep group scalars (and publish local scalars only if group has no register for them)
    const toPublish: LocalChangeInput[] = [];
    for (const entry of localEntries) {
      const existing = this.registers[entry.path];
      if (parseMembershipElementPath(entry.path)) {
        if (!entry.tombstone && (!existing || existing.tombstone)) {
          toPublish.push(entry);
        }
      } else if (!existing) {
        toPublish.push(entry);
      }
    }
    const emitted = await this.applyLocalChangesLocked(toPublish, nowMs);
    return { toApplyLocally: groupApplied, emitted };
  }

  private async appendEnvelope(
    kind: SyncRecordKind,
    body: SyncRecordBody,
    nowMs: number,
    clock?: Hlc,
  ): Promise<SyncRecordEnvelope> {
    const envelope = await this.createEnvelope(kind, body, nowMs, clock);
    return this.commitEnvelope(envelope);
  }

  private async createEnvelope(
    kind: SyncRecordKind,
    body: SyncRecordBody,
    nowMs: number,
    clock?: Hlc,
  ): Promise<SyncRecordEnvelope> {
    const keys = this.epochKeys.get(this.currentEpoch);
    if (!keys) throw new Error(`Missing keys for current epoch ${this.currentEpoch}`);

    const header = {
      deviceId: this.device.deviceId,
      seq: this.seq + 1,
      epoch: this.currentEpoch,
      hlc: clock ?? tickHlc(this.hlc, this.device.deviceId, nowMs),
      configVersion: this.configVersion,
      kind,
    };

    const { nonce, ciphertext } = await sealRecordBody(keys.recordKey, envelopeAad(header), body);
    const unsigned: Omit<SyncRecordEnvelope, 'signature'> = {
      ...header,
      signingPublic: toBase64Url(this.device.signingPublicRaw),
      nonce,
      ciphertext,
    };
    const sig = await signEd25519(this.device.signing.privateKey, envelopeSignPayload(unsigned));
    return { ...unsigned, signature: toBase64Url(sig) };
  }

  private commitEnvelope(envelope: SyncRecordEnvelope): SyncRecordEnvelope {
    this.seq = envelope.seq;
    if (compareHlc(envelope.hlc, this.hlc) > 0) this.hlc = { ...envelope.hlc };
    this.recordLog.set(this.recordKeyId(envelope.deviceId, envelope.seq), envelope);
    this.versionVector[envelope.deviceId] = envelope.seq;
    return envelope;
  }

  private advanceVersionVector(deviceId: string): void {
    let seq = this.versionVector[deviceId] ?? 0;
    while (this.recordLog.has(this.recordKeyId(deviceId, seq + 1))) seq += 1;
    if (seq > 0) this.versionVector[deviceId] = seq;
  }

  private async wrapForActiveMembers(
    newEpoch: number,
    newEntropy: Uint8Array,
    excludeDeviceId?: string,
  ): Promise<WrappedEpochSecret[]> {
    const wrapped: WrappedEpochSecret[] = [];
    for (const member of this.getActiveMembers()) {
      if (member.deviceId === excludeDeviceId) continue;
      if (member.deviceId !== this.device.deviceId && !member.agreementAttested) continue;
      const agreementPublic =
        member.deviceId === this.device.deviceId
          ? toBase64Url(this.device.agreementPublicRaw)
          : member.agreementPublic;
      if (!agreementPublic) continue;
      wrapped.push(
        await wrapGroupEntropyForPeer(
          this.device,
          member.deviceId,
          agreementPublic,
          newEpoch,
          newEntropy,
        ),
      );
    }
    return wrapped;
  }

  private async tryUnwrapEpoch(
    newEpoch: number,
    wrappedSecrets: readonly WrappedEpochSecret[],
  ): Promise<{ secret: CryptoKey } | null> {
    const mine = wrappedSecrets.find((w) => w.recipientDeviceId === this.device.deviceId);
    if (!mine) return null;
    try {
      const entropy = await unwrapGroupEntropyFromPeer(this.device, mine);
      const secret = await importGroupSecret(entropy);
      const nextKeys = await deriveGroupKeys(secret, newEpoch);
      this.registerEpochKeysLocked(nextKeys);
      return { secret };
    } catch {
      return null;
    }
  }
}
