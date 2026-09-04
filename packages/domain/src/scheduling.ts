import { MAX_MONITOR_INTERVAL_SECONDS, MIN_MONITOR_INTERVAL_SECONDS } from './types.js';

const MINUTE_MS = 60_000;
const MIN_STALE_GRACE_MS = 5 * MINUTE_MS;

function intervalToMilliseconds(intervalSec: number): number {
  if (!Number.isSafeInteger(intervalSec) || intervalSec < 1) {
    throw new RangeError('intervalSec must be a positive safe integer');
  }
  return intervalSec * 1_000;
}

function assertDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid date`);
  }
}

/** A deterministic, dependency-free 32-bit hash suitable for scheduling jitter. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function isSupportedIntervalSec(intervalSec: number): boolean {
  return (
    Number.isSafeInteger(intervalSec) &&
    intervalSec >= MIN_MONITOR_INTERVAL_SECONDS &&
    intervalSec <= MAX_MONITOR_INTERVAL_SECONDS
  );
}

/** Returns a stable positive offset within the configured jitter window. */
export function stableJitterMs(monitorId: string, intervalSec: number, jitterRatio = 0.1): number {
  const intervalMs = intervalToMilliseconds(intervalSec);
  if (monitorId.trim().length === 0) {
    throw new RangeError('monitorId cannot be empty');
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError('jitterRatio must be between 0 and 1');
  }

  const windowMs = Math.floor(intervalMs * jitterRatio);
  return windowMs === 0 ? 0 : fnv1a(monitorId) % windowMs;
}

/**
 * Places a newly activated monitor in the next wall-clock interval bucket and
 * adds a monitor-stable offset. Repeated calls with the same inputs are stable.
 */
export function calculateInitialNextCheckAt(options: {
  monitorId: string;
  intervalSec: number;
  now: Date;
  jitterRatio?: number;
}): Date {
  assertDate(options.now, 'now');
  const intervalMs = intervalToMilliseconds(options.intervalSec);
  const bucketStart = Math.floor(options.now.getTime() / intervalMs) * intervalMs + intervalMs;
  const jitter = stableJitterMs(options.monitorId, options.intervalSec, options.jitterRatio);
  return new Date(bucketStart + jitter);
}

/**
 * Calculates the first future slot from the original schedule, not completion
 * time. Missed slots are skipped, preventing both drift and backlog replay.
 */
export function calculateNextCheckAt(options: {
  scheduledAt: Date;
  intervalSec: number;
  now: Date;
}): Date {
  assertDate(options.scheduledAt, 'scheduledAt');
  assertDate(options.now, 'now');
  const intervalMs = intervalToMilliseconds(options.intervalSec);
  const elapsed = options.now.getTime() - options.scheduledAt.getTime();
  const intervalsToAdvance = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
  return new Date(options.scheduledAt.getTime() + intervalsToAdvance * intervalMs);
}

/** Returns only the most recent due slot after downtime. */
export function coalesceDueScheduledAt(options: {
  nextCheckAt: Date;
  intervalSec: number;
  now: Date;
}): Date | null {
  assertDate(options.nextCheckAt, 'nextCheckAt');
  assertDate(options.now, 'now');
  const intervalMs = intervalToMilliseconds(options.intervalSec);
  const elapsed = options.now.getTime() - options.nextCheckAt.getTime();
  if (elapsed < 0) return null;
  return new Date(options.nextCheckAt.getTime() + Math.floor(elapsed / intervalMs) * intervalMs);
}

export function staleAfter(options: { nextCheckAt: Date; intervalSec: number }): Date {
  assertDate(options.nextCheckAt, 'nextCheckAt');
  const graceMs = Math.max(intervalToMilliseconds(options.intervalSec) * 2, MIN_STALE_GRACE_MS);
  return new Date(options.nextCheckAt.getTime() + graceMs);
}

/** STALE is a derived operational warning and is never persisted as health. */
export function isMonitorStale(options: {
  nextCheckAt: Date | null;
  intervalSec: number;
  now: Date;
}): boolean {
  const nextCheckAt = options.nextCheckAt;
  if (nextCheckAt === null) return false;
  assertDate(options.now, 'now');
  return (
    options.now.getTime() > staleAfter({ nextCheckAt, intervalSec: options.intervalSec }).getTime()
  );
}
