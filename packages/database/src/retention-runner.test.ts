import { describe, expect, it, vi } from 'vitest';

import type { RetentionConfig } from './retention-config.js';
import {
  RETENTION_BOUNDARY_SQL,
  RETENTION_REDACTION_STEPS,
  RETENTION_STEPS,
} from './retention-plan.js';
import { runRetention, type RetentionConnection } from './retention-runner.js';

const config: RetentionConfig = {
  databaseUrl: 'mysql://database/linkalive',
  checkResultDays: 30,
  historyDays: 365,
  batchSize: 5,
  maxBatchesPerStep: 2,
};

const boundaries = {
  boundary_at: new Date('2026-09-03T03:30:00.123Z'),
  check_result_cutoff: new Date('2026-08-04T03:30:00.123Z'),
  history_cutoff: new Date('2025-09-03T03:30:00.123Z'),
};

function connectionWithQuery(query: ReturnType<typeof vi.fn>): RetentionConnection {
  return {
    query,
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  } as unknown as RetentionConnection;
}

describe('MySQL retention runner', () => {
  it('skips immediately when another session owns the named lock', async () => {
    const query = vi.fn().mockResolvedValue([[{ acquired: 0 }], []]);
    const connection = connectionWithQuery(query);

    const result = await runRetention(connection, config);

    expect(result).toMatchObject({ status: 'skipped', reason: 'already_running' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('GET_LOCK');
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('reuses one UTC database boundary and commits every FK-ordered step separately', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql === RETENTION_BOUNDARY_SQL) return [[boundaries], []];
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [[], []];
      return [[], []];
    });
    const connection = connectionWithQuery(query);

    const result = await runRetention(connection, config);

    expect(result).toMatchObject({
      status: 'completed',
      boundaryAt: boundaries.boundary_at.toISOString(),
      cutoffs: {
        checkResultsAndScheduledChecks: boundaries.check_result_cutoff.toISOString(),
        incidentNotificationAndAuditHistory: boundaries.history_cutoff.toISOString(),
      },
      totalDeleted: 0,
      totalRedacted: 0,
    });
    expect(connection.beginTransaction).toHaveBeenCalledTimes(9);
    expect(connection.commit).toHaveBeenCalledTimes(9);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toContain('RELEASE_LOCK');

    const deleteParameters = RETENTION_STEPS.map(
      (step) => query.mock.calls.find(([sql]) => sql === step.selectSql)?.[1],
    );
    expect(deleteParameters).toEqual([
      [boundaries.check_result_cutoff, config.batchSize],
      [boundaries.check_result_cutoff, config.batchSize],
      [boundaries.history_cutoff, boundaries.history_cutoff, config.batchSize],
      [boundaries.history_cutoff, config.batchSize],
      [boundaries.history_cutoff, config.batchSize],
      [boundaries.history_cutoff, config.batchSize],
    ]);
  });

  it('stops a delete step at its batch bound and reports possible backlog', async () => {
    const ids = Array.from({ length: config.batchSize }, (_, index) => ({ id: `result-${index}` }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql === RETENTION_BOUNDARY_SQL) return [[boundaries], []];
      if (sql === RETENTION_STEPS[0]!.selectSql) return [ids, []];
      if (sql === RETENTION_STEPS[0]!.mutateSql) {
        return [{ affectedRows: config.batchSize }, []];
      }
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [[], []];
      return [[], []];
    });
    const connection = connectionWithQuery(query);

    const result = await runRetention(connection, config);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completed retention result.');
    expect(result.steps.checkResults).toEqual({ batches: 2, deleted: 10, limitReached: true });
    expect(result.steps.scheduledChecks.limitReached).toBe(false);
  });

  it('bounds secret redaction independently and reports affected rows', async () => {
    const ids = Array.from({ length: config.batchSize }, (_, index) => ({
      id: `monitor-${index}`,
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql === RETENTION_BOUNDARY_SQL) return [[boundaries], []];
      if (sql === RETENTION_REDACTION_STEPS[0]!.selectSql) return [ids, []];
      if (sql === RETENTION_REDACTION_STEPS[0]!.mutateSql) {
        return [{ affectedRows: config.batchSize }, []];
      }
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [[], []];
      return [[], []];
    });
    const connection = connectionWithQuery(query);

    const result = await runRetention(connection, config);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completed retention result.');
    expect(result.secretRedactions.deletedMonitors).toEqual({
      batches: 2,
      redacted: 10,
      limitReached: true,
    });
    expect(result.secretRedactions.terminalNotificationOutbox.redacted).toBe(0);
    expect(result.totalRedacted).toBe(10);
    expect(result.totalDeleted).toBe(0);
  });

  it('rolls back if a mutation misses a previously locked candidate', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql === RETENTION_BOUNDARY_SQL) return [[boundaries], []];
      if (sql === RETENTION_REDACTION_STEPS[0]!.selectSql) return [[{ id: 'monitor-1' }], []];
      if (sql === RETENTION_REDACTION_STEPS[0]!.mutateSql) return [{ affectedRows: 0 }, []];
      return [[], []];
    });
    const connection = connectionWithQuery(query);

    await expect(runRetention(connection, config)).rejects.toThrow(
      'did not affect every locked candidate',
    );
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.at(-1)?.[0]).toContain('RELEASE_LOCK');
  });
});
