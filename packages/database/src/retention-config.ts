export const RETENTION_DEFAULTS = {
  checkResultDays: 30,
  historyDays: 365,
  batchSize: 500,
  maxBatchesPerStep: 100,
} as const;

export interface RetentionConfig {
  databaseUrl: string;
  checkResultDays: number;
  historyDays: number;
  batchSize: number;
  maxBatchesPerStep: number;
}

interface IntegerRange {
  minimum: number;
  maximum: number;
}

function readInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  range: IntegerRange,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be a whole number between ${range.minimum} and ${range.maximum}.`,
    );
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < range.minimum || value > range.maximum) {
    throw new Error(
      `${name} must be a whole number between ${range.minimum} and ${range.maximum}.`,
    );
  }
  return value;
}

export function readRetentionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RetentionConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required for the retention command.');
  }
  try {
    if (new URL(databaseUrl).protocol !== 'mysql:') {
      throw new Error();
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid mysql:// URL.');
  }

  return {
    databaseUrl,
    checkResultDays: readInteger(
      environment,
      'RETENTION_CHECK_RESULT_DAYS',
      RETENTION_DEFAULTS.checkResultDays,
      { minimum: 1, maximum: 3_650 },
    ),
    historyDays: readInteger(
      environment,
      'RETENTION_HISTORY_DAYS',
      RETENTION_DEFAULTS.historyDays,
      { minimum: 1, maximum: 36_500 },
    ),
    batchSize: readInteger(environment, 'RETENTION_BATCH_SIZE', RETENTION_DEFAULTS.batchSize, {
      minimum: 1,
      maximum: 10_000,
    }),
    maxBatchesPerStep: readInteger(
      environment,
      'RETENTION_MAX_BATCHES_PER_STEP',
      RETENTION_DEFAULTS.maxBatchesPerStep,
      { minimum: 1, maximum: 1_000 },
    ),
  };
}
