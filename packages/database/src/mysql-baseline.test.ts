import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../prisma/migrations/20260903000000_mysql_init/migration.sql', import.meta.url),
);
const migration = readFileSync(migrationPath, 'utf8');

describe('MySQL baseline migration', () => {
  it('uses MySQL/MariaDB storage types without PostgreSQL syntax', () => {
    expect(migration).toContain('DATETIME(3)');
    expect(migration).toContain('BLOB NOT NULL');
    expect(migration).toContain('JSON NOT NULL');
    expect(migration).not.toMatch(/TIMESTAMPTZ|JSONB|BYTEA|gen_random_uuid|::/i);
  });

  it('enforces one active scheduled check using a nullable generated key', () => {
    expect(migration).toMatch(
      /`active_monitor_id` VARCHAR\(36\)[\s\S]*GENERATED ALWAYS AS[\s\S]*'PENDING'[\s\S]*'ENQUEUED'[\s\S]*'RUNNING'[\s\S]*RTRIM\(`monitor_id`\)[\s\S]*STORED/,
    );
    expect(migration).toContain(
      'UNIQUE INDEX `scheduled_checks_one_active_per_monitor_idx`(`active_monitor_id`)',
    );
  });

  it('enforces one open incident using a nullable generated key', () => {
    expect(migration).toMatch(
      /`open_monitor_id` VARCHAR\(36\)[\s\S]*GENERATED ALWAYS AS[\s\S]*`status` = 'OPEN'[\s\S]*RTRIM\(`monitor_id`\)[\s\S]*STORED/,
    );
    expect(migration).toContain(
      'UNIQUE INDEX `incidents_one_open_per_monitor_idx`(`open_monitor_id`)',
    );
  });

  it('retains ledger identity, state coherence, and bounded-maintenance indexes', () => {
    expect(migration).toContain('CONSTRAINT `check_results_scheduled_identity_fkey`');
    expect(migration).toContain('CONSTRAINT `check_results_source_ledger_check`');
    expect(migration).toContain('CONSTRAINT `incidents_closure_check`');
    expect(migration).toContain('CONSTRAINT `notification_outbox_sequence_check`');
    expect(migration).toContain('INDEX `check_results_retention_finished_idx`');
    expect(migration).toContain('INDEX `audit_logs_retention_batch_idx`');
    expect(migration).toContain('ON UPDATE RESTRICT');
    expect(migration).not.toContain('ON UPDATE CASCADE');
  });
});
