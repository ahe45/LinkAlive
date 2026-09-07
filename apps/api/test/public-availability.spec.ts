import { describe, expect, it } from 'vitest';
import {
  publicAvailabilityWindow,
  summarizePublicAvailability,
} from '../src/dashboard/public-availability.js';

describe('public availability statistics', () => {
  const now = new Date('2026-09-07T09:00:00.000Z');

  it('uses the latest ten rolling 24-hour periods', () => {
    const window = publicAvailabilityWindow(now);

    expect(window.start.toISOString()).toBe('2026-08-28T09:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-09-07T09:00:00.000Z');
  });

  it('calculates weighted availability and preserves days without checks', () => {
    const stats = summarizePublicAvailability(
      [
        { bucketIndex: 0n, successCount: 9n, totalCount: 10n },
        { bucketIndex: 9n, successCount: 80n, totalCount: 90n },
      ],
      now,
    );

    expect(stats.availabilityPercent).toBe(89);
    expect(stats.daily).toHaveLength(10);
    expect(stats.daily[0]).toEqual({
      startedAt: '2026-08-28T09:00:00.000Z',
      availabilityPercent: 90,
    });
    expect(stats.daily[1]?.availabilityPercent).toBeNull();
    expect(stats.daily[9]?.availabilityPercent).toBe(88.89);
  });

  it('returns null availability when there are no eligible checks', () => {
    const stats = summarizePublicAvailability([], now);

    expect(stats.availabilityPercent).toBeNull();
    expect(stats.daily.every((item) => item.availabilityPercent === null)).toBe(true);
  });
});
