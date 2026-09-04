import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { RetentionConfig } from './retention-config.js';
import {
  RETENTION_BOUNDARY_SQL,
  RETENTION_REDACTION_STEPS,
  RETENTION_STEPS,
  type RetentionRedactionStep,
  type RetentionRedactionStepKey,
  type RetentionStep,
  type RetentionStepKey,
} from './retention-plan.js';

const ADVISORY_LOCK_NAME = 'linkalive:retention:v1';

interface BoundaryRow extends RowDataPacket {
  boundary_at: Date | string;
  check_result_cutoff: Date | string;
  history_cutoff: Date | string;
}

interface LockRow extends RowDataPacket {
  acquired: number | string | null;
}

interface CandidateRow extends RowDataPacket {
  id: string;
}

/** A dedicated mysql2 connection is required because GET_LOCK is session-owned. */
export type RetentionConnection = Pick<
  Connection,
  'query' | 'beginTransaction' | 'commit' | 'rollback'
>;

export interface RetentionStepResult {
  batches: number;
  deleted: number;
  limitReached: boolean;
}

export interface RetentionRedactionStepResult {
  batches: number;
  redacted: number;
  limitReached: boolean;
}

export interface RetentionCompletedResult {
  event: 'linkalive.retention.completed';
  status: 'completed';
  startedAt: string;
  finishedAt: string;
  boundaryAt: string;
  cutoffs: {
    checkResultsAndScheduledChecks: string;
    incidentNotificationAndAuditHistory: string;
  };
  policy: {
    checkResultDays: number;
    historyDays: number;
    batchSize: number;
    maxBatchesPerStep: number;
  };
  steps: Record<RetentionStepKey, RetentionStepResult>;
  secretRedactions: Record<RetentionRedactionStepKey, RetentionRedactionStepResult>;
  totalDeleted: number;
  totalRedacted: number;
  durationMs: number;
}

export interface RetentionSkippedResult {
  event: 'linkalive.retention.skipped';
  status: 'skipped';
  reason: 'already_running';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type RetentionRunResult = RetentionCompletedResult | RetentionSkippedResult;

function emptyRedactionResults(): Record<RetentionRedactionStepKey, RetentionRedactionStepResult> {
  return {
    deletedMonitors: { batches: 0, redacted: 0, limitReached: false },
    deletedNotificationChannels: { batches: 0, redacted: 0, limitReached: false },
    terminalNotificationOutbox: { batches: 0, redacted: 0, limitReached: false },
  };
}

function emptyStepResults(): Record<RetentionStepKey, RetentionStepResult> {
  return {
    checkResults: { batches: 0, deleted: 0, limitReached: false },
    scheduledChecks: { batches: 0, deleted: 0, limitReached: false },
    notificationDeliveries: { batches: 0, deleted: 0, limitReached: false },
    notificationOutbox: { batches: 0, deleted: 0, limitReached: false },
    incidents: { batches: 0, deleted: 0, limitReached: false },
    auditLogs: { batches: 0, deleted: 0, limitReached: false },
  };
}

function parseDatabaseDate(value: Date | string, field: string): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string') {
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  throw new Error(`MySQL returned an invalid ${field} retention boundary.`);
}

async function mutateLockedCandidates(
  connection: RetentionConnection,
  selectSql: string,
  selectParameters: unknown[],
  mutateSql: string,
): Promise<number> {
  await connection.beginTransaction();
  try {
    const [candidateRows] = await connection.query<CandidateRow[]>(selectSql, selectParameters);
    const ids = candidateRows.map(({ id }) => id);
    if (ids.length === 0) {
      await connection.commit();
      return 0;
    }

    const [mutation] = await connection.query<ResultSetHeader>(mutateSql, [ids]);
    if (!Number.isInteger(mutation.affectedRows) || mutation.affectedRows < 0) {
      throw new Error('The retention mutation returned an invalid affected row count.');
    }
    if (mutation.affectedRows !== ids.length) {
      throw new Error('The retention mutation did not affect every locked candidate.');
    }
    await connection.commit();
    return mutation.affectedRows;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function redactBatch(
  connection: RetentionConnection,
  step: RetentionRedactionStep,
  batchSize: number,
): Promise<number> {
  return mutateLockedCandidates(connection, step.selectSql, [batchSize], step.mutateSql);
}

async function deleteBatch(
  connection: RetentionConnection,
  step: RetentionStep,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const cutoffParameters = Array.from({ length: step.cutoffParameters }, () => cutoff);
  return mutateLockedCandidates(
    connection,
    step.selectSql,
    [...cutoffParameters, batchSize],
    step.mutateSql,
  );
}

export async function runRetention(
  connection: RetentionConnection,
  config: RetentionConfig,
): Promise<RetentionRunResult> {
  const startedAt = new Date();
  const [lockRows] = await connection.query<LockRow[]>('SELECT GET_LOCK(?, 0) AS acquired', [
    ADVISORY_LOCK_NAME,
  ]);
  if (Number(lockRows[0]?.acquired) !== 1) {
    const finishedAt = new Date();
    return {
      event: 'linkalive.retention.skipped',
      status: 'skipped',
      reason: 'already_running',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  try {
    // Bound lock waits for each maintenance batch without depending on the
    // MySQL-only MAX_EXECUTION_TIME or MariaDB-only max_statement_time knobs.
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');

    const [boundaryRows] = await connection.query<BoundaryRow[]>(RETENTION_BOUNDARY_SQL, [
      config.checkResultDays,
      config.historyDays,
    ]);
    const boundaries = boundaryRows[0];
    if (!boundaries) throw new Error('MySQL did not return retention boundaries.');
    const boundaryAt = parseDatabaseDate(boundaries.boundary_at, 'clock');
    const checkResultCutoff = parseDatabaseDate(
      boundaries.check_result_cutoff,
      'check-result cutoff',
    );
    const historyCutoff = parseDatabaseDate(boundaries.history_cutoff, 'history cutoff');

    const secretRedactions = emptyRedactionResults();
    let totalRedacted = 0;
    for (const step of RETENTION_REDACTION_STEPS) {
      let lastBatchSize = 0;
      for (let batch = 0; batch < config.maxBatchesPerStep; batch += 1) {
        lastBatchSize = await redactBatch(connection, step, config.batchSize);
        secretRedactions[step.key].batches += 1;
        secretRedactions[step.key].redacted += lastBatchSize;
        totalRedacted += lastBatchSize;
        if (lastBatchSize < config.batchSize) break;
      }
      secretRedactions[step.key].limitReached =
        secretRedactions[step.key].batches === config.maxBatchesPerStep &&
        lastBatchSize === config.batchSize;
    }

    const steps = emptyStepResults();
    let totalDeleted = 0;
    for (const step of RETENTION_STEPS) {
      const cutoff = step.cutoff === 'checkResult' ? checkResultCutoff : historyCutoff;
      let lastBatchSize = 0;
      for (let batch = 0; batch < config.maxBatchesPerStep; batch += 1) {
        lastBatchSize = await deleteBatch(connection, step, cutoff, config.batchSize);
        steps[step.key].batches += 1;
        steps[step.key].deleted += lastBatchSize;
        totalDeleted += lastBatchSize;
        if (lastBatchSize < config.batchSize) break;
      }
      steps[step.key].limitReached =
        steps[step.key].batches === config.maxBatchesPerStep && lastBatchSize === config.batchSize;
    }

    const finishedAt = new Date();
    return {
      event: 'linkalive.retention.completed',
      status: 'completed',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      boundaryAt: boundaryAt.toISOString(),
      cutoffs: {
        checkResultsAndScheduledChecks: checkResultCutoff.toISOString(),
        incidentNotificationAndAuditHistory: historyCutoff.toISOString(),
      },
      policy: {
        checkResultDays: config.checkResultDays,
        historyDays: config.historyDays,
        batchSize: config.batchSize,
        maxBatchesPerStep: config.maxBatchesPerStep,
      },
      steps,
      secretRedactions,
      totalDeleted,
      totalRedacted,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?) AS released', [ADVISORY_LOCK_NAME]);
  }
}
