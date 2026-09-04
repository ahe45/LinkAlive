import { describe, expect, it } from 'vitest';

import {
  calculateInitialNextCheckAt,
  calculateNextCheckAt,
  coalesceDueScheduledAt,
  isMonitorStale,
  isSupportedIntervalSec,
  stableJitterMs,
} from './scheduling.js';

describe('scheduling', () => {
  it('uses stable, bounded monitor jitter', () => {
    const first = stableJitterMs('monitor-a', 60);
    const second = stableJitterMs('monitor-a', 60);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(6_000);
  });

  it('places initial work into the next interval bucket', () => {
    const now = new Date('2026-09-03T00:00:42.000Z');
    const next = calculateInitialNextCheckAt({
      monitorId: 'monitor-a',
      intervalSec: 60,
      now,
      jitterRatio: 0,
    });
    expect(next.toISOString()).toBe('2026-09-03T00:01:00.000Z');
  });

  it('skips missed slots while retaining the original schedule anchor', () => {
    const scheduledAt = new Date('2026-09-03T00:00:10.000Z');
    const now = new Date('2026-09-03T00:03:25.000Z');
    expect(calculateNextCheckAt({ scheduledAt, intervalSec: 60, now }).toISOString()).toBe(
      '2026-09-03T00:04:10.000Z',
    );
    expect(
      coalesceDueScheduledAt({
        nextCheckAt: scheduledAt,
        intervalSec: 60,
        now,
      })?.toISOString(),
    ).toBe('2026-09-03T00:03:10.000Z');
  });

  it('derives stale only beyond max(two intervals, five minutes)', () => {
    const nextCheckAt = new Date('2026-09-03T00:00:00.000Z');
    expect(
      isMonitorStale({
        nextCheckAt,
        intervalSec: 60,
        now: new Date('2026-09-03T00:05:00.000Z'),
      }),
    ).toBe(false);
    expect(
      isMonitorStale({
        nextCheckAt,
        intervalSec: 60,
        now: new Date('2026-09-03T00:05:00.001Z'),
      }),
    ).toBe(true);
  });

  it('accepts integer second intervals within the supported range', () => {
    expect(isSupportedIntervalSec(300)).toBe(true);
    expect(isSupportedIntervalSec(17)).toBe(true);
    expect(isSupportedIntervalSec(4)).toBe(false);
    expect(isSupportedIntervalSec(86_401)).toBe(false);
    expect(isSupportedIntervalSec(10.5)).toBe(false);
  });
});
