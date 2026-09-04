import { afterEach, describe, expect, it, vi } from 'vitest';

import { effectiveMonitorState, isMonitorStale } from './format';
import type { Monitor } from './types';

function monitor(healthState: Monitor['healthState']): Monitor {
  return {
    id: 'monitor-1',
    name: '서비스',
    url: 'https://example.com',
    method: 'GET',
    intervalSec: 60,
    timeoutMs: 10_000,
    expectedStatusMin: 200,
    expectedStatusMax: 299,
    followRedirects: true,
    maxRedirects: 5,
    failureThreshold: 3,
    recoveryThreshold: 2,
    lifecycleStatus: 'ACTIVE',
    healthState,
    failureCount: 0,
    successCount: 0,
    nextCheckAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
}

afterEach(() => vi.restoreAllMocks());

describe('monitor display state', () => {
  it.each(['DOWN', 'RECOVERING'] as const)(
    'keeps %s as the primary state even when the schedule is stale',
    (healthState) => {
      vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-03T00:05:00.001Z').getTime());
      const value = monitor(healthState);

      expect(isMonitorStale(value)).toBe(true);
      expect(effectiveMonitorState(value)).toBe(healthState);
    },
  );

  it('keeps ordinary target health separate from the stale warning', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-03T00:05:00.001Z').getTime());
    const value = monitor('UP');

    expect(isMonitorStale(value)).toBe(true);
    expect(effectiveMonitorState(value)).toBe('UP');
  });
});
