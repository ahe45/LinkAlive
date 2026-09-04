import { describe, expect, it } from 'vitest';

import {
  RETENTION_BOUNDARY_SQL,
  RETENTION_REDACTION_STEPS,
  RETENTION_STEPS,
} from './retention-plan.js';

function compact(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('MySQL retention SQL plan', () => {
  it('derives both cutoffs from one UTC database clock boundary', () => {
    const sql = compact(RETENTION_BOUNDARY_SQL);
    expect(sql.match(/UTC_TIMESTAMP\(3\)/g)).toHaveLength(1);
    expect(sql).toContain('DATE_SUB(boundary_at, INTERVAL ? DAY) AS check_result_cutoff');
    expect(sql).toContain('DATE_SUB(boundary_at, INTERVAL ? DAY) AS history_cutoff');
    expect(sql).not.toContain('$1');
  });

  it('redacts soft-deleted secrets and only disposable terminal outbox snapshots', () => {
    expect(RETENTION_REDACTION_STEPS.map((step) => step.key)).toEqual([
      'deletedMonitors',
      'deletedNotificationChannels',
      'terminalNotificationOutbox',
    ]);
    const [monitors, channels, outbox] = RETENTION_REDACTION_STEPS.map((step) =>
      compact(step.selectSql),
    );
    expect(monitors).toContain('monitor.deleted_at IS NOT NULL');
    expect(RETENTION_REDACTION_STEPS[0]!.mutateSql).toContain('SET request_url_encrypted =');
    expect(channels).toContain('channel.deleted_at IS NOT NULL');
    expect(RETENTION_REDACTION_STEPS[1]!.mutateSql).toContain('SET encrypted_config =');
    expect(outbox).toContain("outbox.status IN ('SENT', 'FAILED', 'CANCELED')");
    expect(outbox).toContain('encrypted_config_snapshot');
    expect(outbox).toContain("JSON_EXTRACT(outbox.payload_safe, '$.notifyOnRecovery')");
    expect(outbox).toContain("incident.status = 'OPEN'");
    expect(outbox).toContain("outbox.event_type = 'RECOVERY'");
    expect(outbox).toContain('장애 알림이 전달되지 않아 복구 알림을 취소했습니다.');
    expect(outbox).toContain('channel.deleted_at IS NULL');
    expect(outbox).toContain("down_event.status <> 'CANCELED'");
    expect(outbox).toContain('binding.notify_on_recovery = TRUE');
  });

  it('locks each bounded candidate set using MySQL 8/MariaDB 11 SKIP LOCKED syntax', () => {
    const selects = [
      ...RETENTION_REDACTION_STEPS.map((step) => step.selectSql),
      ...RETENTION_STEPS.map((step) => step.selectSql),
    ];
    for (const sql of selects) {
      expect(compact(sql)).toMatch(/LIMIT \? FOR UPDATE SKIP LOCKED$/);
    }
  });

  it('orders every child before its RESTRICT parent', () => {
    expect(RETENTION_STEPS.map((step) => step.key)).toEqual([
      'checkResults',
      'scheduledChecks',
      'notificationDeliveries',
      'notificationOutbox',
      'incidents',
      'auditLogs',
    ]);
  });

  it('deletes all old check-result sources with an exclusive fixed boundary', () => {
    const step = RETENTION_STEPS[0]!;
    const sql = compact(step.selectSql);
    expect(sql).toContain('result.finished_at < ?');
    expect(sql).not.toContain('result.source =');
    expect(step.mutateSql).toBe('DELETE FROM check_results WHERE id IN (?)');
    expect(step.cutoffParameters).toBe(1);
  });

  it('only deletes terminal scheduled rows after their result is gone', () => {
    const sql = compact(RETENTION_STEPS[1]!.selectSql);
    expect(sql).toContain("scheduled.status IN ('COMPLETED', 'FAILED', 'CANCELED')");
    expect(sql).toContain('result.scheduled_check_id = scheduled.id');
    expect(sql).toContain('NOT EXISTS');
  });

  it('uses both delivery and outbox terminal windows for delivery deletion', () => {
    const delivery = RETENTION_STEPS[2]!;
    const outbox = RETENTION_STEPS[3]!;
    expect(compact(delivery.selectSql)).toContain(
      'COALESCE(delivery.finished_at, delivery.created_at) < ?',
    );
    expect(delivery.cutoffParameters).toBe(2);
    expect(compact(delivery.selectSql)).toContain(
      "outbox.status IN ('SENT', 'FAILED', 'CANCELED')",
    );
    expect(compact(outbox.selectSql)).toContain('delivery.outbox_id = outbox.id');
  });

  it('ages incidents from closure and keeps incidents referenced by outbox', () => {
    const sql = compact(RETENTION_STEPS[4]!.selectSql);
    expect(sql).toContain("incident.status IN ('RESOLVED', 'CANCELED')");
    expect(sql).toContain('COALESCE(incident.resolved_at, incident.canceled_at) < ?');
    expect(sql).toContain('outbox.incident_id = incident.id');
    expect(sql).toContain('NOT EXISTS');
  });

  it('uses the detailed cutoff only for results and scheduled ledgers', () => {
    expect(RETENTION_STEPS.map((step) => step.cutoff)).toEqual([
      'checkResult',
      'checkResult',
      'history',
      'history',
      'history',
      'history',
    ]);
  });
});
