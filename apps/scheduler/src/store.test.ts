import type { PrismaClient } from '@linkalive/database';
import { describe, expect, it, vi } from 'vitest';

import { PrismaSchedulerStore } from './store.js';

function normalizedSql(query: unknown): string {
  const sql = query as { strings: readonly string[] };
  return sql.strings.join('?').replace(/\s+/g, ' ').trim();
}

describe('PrismaSchedulerStore MySQL-compatible locking query', () => {
  it('claims due rows using parameterized MySQL/MariaDB SKIP LOCKED syntax', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const transaction = vi.fn().mockImplementation((operation) =>
      operation({
        $queryRaw: queryRaw,
      }),
    );
    const store = new PrismaSchedulerStore({
      $transaction: transaction,
    } as unknown as PrismaClient);

    await expect(store.createDueChecks(new Date('2026-09-03T00:00:00.000Z'), 25)).resolves.toEqual(
      [],
    );

    expect(queryRaw).toHaveBeenCalledOnce();
    const sql = normalizedSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("lifecycle_status = 'ACTIVE'");
    expect(sql).toContain("sc.status IN ( 'PENDING', 'ENQUEUED', 'RUNNING' )");
    expect(sql).toMatch(/ORDER BY next_check_at ASC LIMIT \? FOR UPDATE SKIP LOCKED$/);
    expect(sql).not.toContain('::');
  });
});
