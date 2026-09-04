import {
  DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
  SECRET_TOMBSTONE_TEXT,
} from './secret-tombstone.js';

export type RetentionCutoff = 'checkResult' | 'history';

export type RetentionRedactionStepKey =
  'deletedMonitors' | 'deletedNotificationChannels' | 'terminalNotificationOutbox';

export type RetentionStepKey =
  | 'checkResults'
  | 'scheduledChecks'
  | 'notificationDeliveries'
  | 'notificationOutbox'
  | 'incidents'
  | 'auditLogs';

/**
 * MySQL/MariaDB do not support DELETE ... RETURNING. Each batch therefore
 * locks a bounded set of primary keys and mutates exactly those rows in the
 * same transaction. `IN (?)` intentionally relies on mysql2's safe array
 * expansion; candidate IDs always come from the preceding SELECT.
 */
export interface RetentionStep {
  key: RetentionStepKey;
  cutoff: RetentionCutoff;
  cutoffParameters: 1 | 2;
  selectSql: string;
  mutateSql: string;
}

export interface RetentionRedactionStep {
  key: RetentionRedactionStepKey;
  selectSql: string;
  mutateSql: string;
}

const tombstoneSql = `CAST('${SECRET_TOMBSTONE_TEXT}' AS BINARY)`;

const selectDeletedMonitorsSql = `
SELECT monitor.id
FROM monitors AS monitor
WHERE monitor.deleted_at IS NOT NULL
  AND monitor.request_url_encrypted <> ${tombstoneSql}
ORDER BY monitor.deleted_at, monitor.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectDeletedNotificationChannelsSql = `
SELECT channel.id
FROM notification_channels AS channel
WHERE channel.deleted_at IS NOT NULL
  AND channel.encrypted_config <> ${tombstoneSql}
ORDER BY channel.deleted_at, channel.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectTerminalNotificationOutboxSql = `
SELECT outbox.id
FROM notification_outbox AS outbox
WHERE outbox.status IN ('SENT', 'FAILED', 'CANCELED')
  AND outbox.encrypted_config_snapshot <> ${tombstoneSql}
  AND NOT (
    outbox.event_type = 'DOWN'
    AND outbox.status = 'SENT'
    AND JSON_UNQUOTE(JSON_EXTRACT(outbox.payload_safe, '$.notifyOnRecovery')) = 'true'
    AND EXISTS (
      SELECT 1
      FROM incidents AS incident
      WHERE incident.id = outbox.incident_id
        AND incident.status = 'OPEN'
    )
    AND EXISTS (
      SELECT 1
      FROM notification_channels AS channel
      WHERE channel.id = outbox.channel_id
        AND channel.enabled = TRUE
        AND channel.deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM monitor_channels AS binding
      WHERE binding.monitor_id = outbox.monitor_id
        AND binding.channel_id = outbox.channel_id
        AND binding.notify_on_recovery = TRUE
    )
  )
  AND NOT (
    outbox.event_type = 'RECOVERY'
    AND outbox.status = 'CANCELED'
    AND outbox.last_error_safe = '${DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON}'
    AND EXISTS (
      SELECT 1
      FROM notification_channels AS channel
      WHERE channel.id = outbox.channel_id
        AND channel.enabled = TRUE
        AND channel.deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM notification_outbox AS down_event
      WHERE down_event.incident_id = outbox.incident_id
        AND down_event.channel_id = outbox.channel_id
        AND down_event.event_type = 'DOWN'
        AND down_event.status <> 'CANCELED'
    )
    AND EXISTS (
      SELECT 1
      FROM monitor_channels AS binding
      WHERE binding.monitor_id = outbox.monitor_id
        AND binding.channel_id = outbox.channel_id
        AND binding.notify_on_recovery = TRUE
    )
  )
ORDER BY outbox.updated_at, outbox.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

// Redaction has no age threshold: a retired credential has no diagnostic
// value. These bounded steps also backstop rows written by older releases.
export const RETENTION_REDACTION_STEPS: readonly RetentionRedactionStep[] = [
  {
    key: 'deletedMonitors',
    selectSql: selectDeletedMonitorsSql,
    mutateSql: `UPDATE monitors SET request_url_encrypted = ${tombstoneSql} WHERE id IN (?)`,
  },
  {
    key: 'deletedNotificationChannels',
    selectSql: selectDeletedNotificationChannelsSql,
    mutateSql: `UPDATE notification_channels SET encrypted_config = ${tombstoneSql} WHERE id IN (?)`,
  },
  {
    key: 'terminalNotificationOutbox',
    selectSql: selectTerminalNotificationOutboxSql,
    mutateSql: `UPDATE notification_outbox SET encrypted_config_snapshot = ${tombstoneSql} WHERE id IN (?)`,
  },
] as const;

// `UTC_TIMESTAMP(3)` is captured in one CTE and the exact values returned by
// the database are reused in every batch. DATETIME values are UTC by contract.
export const RETENTION_BOUNDARY_SQL = `
WITH boundary AS (SELECT UTC_TIMESTAMP(3) AS boundary_at)
SELECT
  boundary_at,
  DATE_SUB(boundary_at, INTERVAL ? DAY) AS check_result_cutoff,
  DATE_SUB(boundary_at, INTERVAL ? DAY) AS history_cutoff
FROM boundary
`;

const selectCheckResultsSql = `
SELECT result.id
FROM check_results AS result
WHERE result.finished_at < ?
ORDER BY result.finished_at, result.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectScheduledChecksSql = `
SELECT scheduled.id
FROM scheduled_checks AS scheduled
WHERE scheduled.status IN ('COMPLETED', 'FAILED', 'CANCELED')
  AND COALESCE(scheduled.completed_at, scheduled.canceled_at, scheduled.updated_at) < ?
  AND NOT EXISTS (
    SELECT 1
    FROM check_results AS result
    WHERE result.scheduled_check_id = scheduled.id
  )
ORDER BY COALESCE(scheduled.completed_at, scheduled.canceled_at, scheduled.updated_at), scheduled.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectNotificationDeliveriesSql = `
SELECT delivery.id
FROM notification_deliveries AS delivery
INNER JOIN notification_outbox AS outbox ON outbox.id = delivery.outbox_id
WHERE outbox.status IN ('SENT', 'FAILED', 'CANCELED')
  AND COALESCE(delivery.finished_at, delivery.created_at) < ?
  AND COALESCE(outbox.sent_at, outbox.failed_at, outbox.canceled_at, outbox.updated_at) < ?
ORDER BY COALESCE(delivery.finished_at, delivery.created_at), delivery.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectNotificationOutboxSql = `
SELECT outbox.id
FROM notification_outbox AS outbox
WHERE outbox.status IN ('SENT', 'FAILED', 'CANCELED')
  AND COALESCE(outbox.sent_at, outbox.failed_at, outbox.canceled_at, outbox.updated_at) < ?
  AND NOT EXISTS (
    SELECT 1
    FROM notification_deliveries AS delivery
    WHERE delivery.outbox_id = outbox.id
  )
ORDER BY COALESCE(outbox.sent_at, outbox.failed_at, outbox.canceled_at, outbox.updated_at), outbox.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectIncidentsSql = `
SELECT incident.id
FROM incidents AS incident
WHERE incident.status IN ('RESOLVED', 'CANCELED')
  AND COALESCE(incident.resolved_at, incident.canceled_at) < ?
  AND NOT EXISTS (
    SELECT 1
    FROM notification_outbox AS outbox
    WHERE outbox.incident_id = incident.id
  )
ORDER BY COALESCE(incident.resolved_at, incident.canceled_at), incident.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

const selectAuditLogsSql = `
SELECT audit.id
FROM audit_logs AS audit
WHERE audit.created_at < ?
ORDER BY audit.created_at, audit.id
LIMIT ?
FOR UPDATE SKIP LOCKED
`;

// Child rows are always removed before their RESTRICT-protected parents.
export const RETENTION_STEPS: readonly RetentionStep[] = [
  {
    key: 'checkResults',
    cutoff: 'checkResult',
    cutoffParameters: 1,
    selectSql: selectCheckResultsSql,
    mutateSql: 'DELETE FROM check_results WHERE id IN (?)',
  },
  {
    key: 'scheduledChecks',
    cutoff: 'checkResult',
    cutoffParameters: 1,
    selectSql: selectScheduledChecksSql,
    mutateSql: 'DELETE FROM scheduled_checks WHERE id IN (?)',
  },
  {
    key: 'notificationDeliveries',
    cutoff: 'history',
    cutoffParameters: 2,
    selectSql: selectNotificationDeliveriesSql,
    mutateSql: 'DELETE FROM notification_deliveries WHERE id IN (?)',
  },
  {
    key: 'notificationOutbox',
    cutoff: 'history',
    cutoffParameters: 1,
    selectSql: selectNotificationOutboxSql,
    mutateSql: 'DELETE FROM notification_outbox WHERE id IN (?)',
  },
  {
    key: 'incidents',
    cutoff: 'history',
    cutoffParameters: 1,
    selectSql: selectIncidentsSql,
    mutateSql: 'DELETE FROM incidents WHERE id IN (?)',
  },
  {
    key: 'auditLogs',
    cutoff: 'history',
    cutoffParameters: 1,
    selectSql: selectAuditLogsSql,
    mutateSql: 'DELETE FROM audit_logs WHERE id IN (?)',
  },
] as const;
