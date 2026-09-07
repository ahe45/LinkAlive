const DAY_MS = 24 * 60 * 60 * 1_000;

export const PUBLIC_AVAILABILITY_WINDOW_DAYS = 10;

export interface AvailabilityAggregateRow {
  bucketIndex: bigint | number;
  successCount: bigint | number;
  totalCount: bigint | number;
}

export interface PublicAvailabilityStats {
  windowDays: number;
  from: string;
  to: string;
  availabilityPercent: number | null;
  daily: Array<{
    startedAt: string;
    availabilityPercent: number | null;
  }>;
}

export function publicAvailabilityWindow(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - PUBLIC_AVAILABILITY_WINDOW_DAYS * DAY_MS),
    end: now,
  };
}

export function summarizePublicAvailability(
  rows: AvailabilityAggregateRow[],
  now = new Date(),
): PublicAvailabilityStats {
  const { start, end } = publicAvailabilityWindow(now);
  const aggregates = new Map<number, { successCount: number; totalCount: number }>();

  for (const row of rows) {
    const bucketIndex = Number(row.bucketIndex);
    const successCount = Number(row.successCount);
    const totalCount = Number(row.totalCount);
    if (
      !Number.isInteger(bucketIndex) ||
      bucketIndex < 0 ||
      bucketIndex >= PUBLIC_AVAILABILITY_WINDOW_DAYS ||
      !Number.isSafeInteger(successCount) ||
      !Number.isSafeInteger(totalCount) ||
      successCount < 0 ||
      totalCount <= 0 ||
      successCount > totalCount
    ) {
      continue;
    }
    aggregates.set(bucketIndex, { successCount, totalCount });
  }

  let successCount = 0;
  let totalCount = 0;
  const daily = Array.from({ length: PUBLIC_AVAILABILITY_WINDOW_DAYS }, (_, bucketIndex) => {
    const aggregate = aggregates.get(bucketIndex);
    if (aggregate) {
      successCount += aggregate.successCount;
      totalCount += aggregate.totalCount;
    }
    return {
      startedAt: new Date(start.getTime() + bucketIndex * DAY_MS).toISOString(),
      availabilityPercent: aggregate
        ? availabilityPercent(aggregate.successCount, aggregate.totalCount)
        : null,
    };
  });

  return {
    windowDays: PUBLIC_AVAILABILITY_WINDOW_DAYS,
    from: start.toISOString(),
    to: end.toISOString(),
    availabilityPercent: totalCount > 0 ? availabilityPercent(successCount, totalCount) : null,
    daily,
  };
}

function availabilityPercent(successCount: number, totalCount: number): number {
  return Math.round((successCount / totalCount) * 10_000) / 100;
}
