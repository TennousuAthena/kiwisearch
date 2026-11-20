export interface Hlc {
  /** 48-bit wall-clock milliseconds */
  ms: number;
  /** 16-bit logical counter */
  counter: number;
  /** Deterministic tie-breaker */
  deviceId: string;
}

export const MAX_HLC_COUNTER = 0xffff;
export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000;

export function createHlc(deviceId: string, nowMs = Date.now()): Hlc {
  return { ms: Math.max(0, Math.floor(nowMs)), counter: 0, deviceId };
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId < b.deviceId ? -1 : 1;
}

export function tickHlc(local: Hlc, deviceId: string, nowMs = Date.now()): Hlc {
  const physical = Math.max(0, Math.floor(nowMs));
  if (physical > local.ms) {
    return { ms: physical, counter: 0, deviceId };
  }
  if (local.counter >= MAX_HLC_COUNTER) {
    return { ms: local.ms + 1, counter: 0, deviceId };
  }
  return { ms: local.ms, counter: local.counter + 1, deviceId };
}

export function isHlcDriftAcceptable(remote: Hlc, nowMs = Date.now(), maxDriftMs = MAX_FUTURE_DRIFT_MS): boolean {
  if (!Number.isInteger(remote.ms) || remote.ms < 0) return false;
  if (!Number.isInteger(remote.counter) || remote.counter < 0 || remote.counter > MAX_HLC_COUNTER) return false;
  if (!remote.deviceId) return false;
  return remote.ms - nowMs <= maxDriftMs;
}

export function receiveHlc(local: Hlc, remote: Hlc, deviceId: string, nowMs = Date.now()): Hlc {
  if (!isHlcDriftAcceptable(remote, nowMs)) {
    throw new Error(`Remote HLC exceeds allowed future drift (${remote.ms - nowMs}ms)`);
  }
  const physical = Math.max(0, Math.floor(nowMs));
  const maxMs = Math.max(physical, local.ms, remote.ms);
  let counter = 0;
  if (maxMs === local.ms && maxMs === remote.ms) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (maxMs === local.ms) {
    counter = local.counter + 1;
  } else if (maxMs === remote.ms) {
    counter = remote.counter + 1;
  }
  if (counter > MAX_HLC_COUNTER) {
    return { ms: maxMs + 1, counter: 0, deviceId };
  }
  return { ms: maxMs, counter, deviceId };
}
