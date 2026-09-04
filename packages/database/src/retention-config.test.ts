import { describe, expect, it } from 'vitest';

import { RETENTION_DEFAULTS, readRetentionConfig } from './retention-config.js';

describe('retention configuration', () => {
  it('uses bounded operational defaults', () => {
    expect(readRetentionConfig({ DATABASE_URL: 'mysql://database/linkalive' })).toEqual({
      databaseUrl: 'mysql://database/linkalive',
      ...RETENTION_DEFAULTS,
    });
  });

  it('reads explicit retention windows and batch bounds', () => {
    expect(
      readRetentionConfig({
        DATABASE_URL: 'mysql://database/linkalive',
        RETENTION_CHECK_RESULT_DAYS: '45',
        RETENTION_HISTORY_DAYS: '730',
        RETENTION_BATCH_SIZE: '250',
        RETENTION_MAX_BATCHES_PER_STEP: '12',
      }),
    ).toMatchObject({
      checkResultDays: 45,
      historyDays: 730,
      batchSize: 250,
      maxBatchesPerStep: 12,
    });
  });

  it.each([
    ['RETENTION_CHECK_RESULT_DAYS', '0'],
    ['RETENTION_HISTORY_DAYS', '-1'],
    ['RETENTION_BATCH_SIZE', '100.5'],
    ['RETENTION_BATCH_SIZE', '10001'],
    ['RETENTION_MAX_BATCHES_PER_STEP', ''],
    ['RETENTION_MAX_BATCHES_PER_STEP', '1001'],
  ])('rejects invalid %s values', (name, value) => {
    expect(() =>
      readRetentionConfig({ DATABASE_URL: 'mysql://database/linkalive', [name]: value }),
    ).toThrow(name);
  });

  it('requires a database URL without including a supplied secret in the error', () => {
    expect(() => readRetentionConfig({ DATABASE_URL: '   ' })).toThrow('DATABASE_URL is required');
  });

  it('rejects non-MySQL connection URLs', () => {
    expect(() => readRetentionConfig({ DATABASE_URL: 'postgresql://database/linkalive' })).toThrow(
      'valid mysql:// URL',
    );
  });
});
