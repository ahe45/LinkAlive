import { createCipheriv, randomBytes } from 'node:crypto';

import {
  CheckOutcome,
  CheckSource,
  MonitorHealth,
  MonitorLifecycle,
  ScheduledCheckStatus,
  type PrismaClient,
} from '@linkalive/database';
import type { MonitorCheckResult } from '@linkalive/monitoring';
import { describe, expect, it, vi } from 'vitest';

import { ScheduledCheckProcessor } from './check-processor.js';

function normalizedSql(query: unknown): string {
  const sql = query as { strings: readonly string[] };
  return sql.strings.join('?').replace(/\s+/g, ' ').trim();
}

function encryptString(value: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.from(
    [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.'),
  );
}

describe('ScheduledCheckProcessor result snapshots', () => {
  it('stores the URL display used by the request when config changes in flight', async () => {
    const encryptionKey = randomBytes(32);
    const oldRequestUrl = 'https://old.example.com/private?token=hidden';
    const oldDisplayUrl = 'https://old.example.com/private';
    const newDisplayUrl = 'https://new.example.com/health';
    const startedAt = new Date('2026-09-03T00:00:00.000Z');
    const finishedAt = new Date('2026-09-03T00:00:00.125Z');
    const result: MonitorCheckResult = {
      source: CheckSource.SCHEDULED,
      outcome: CheckOutcome.SUCCESS,
      configVersion: 1,
      startedAt,
      finishedAt,
      statusCode: 200,
      ttfbMs: 50,
      totalMs: 125,
      errorType: null,
      finalUrlDisplay: oldDisplayUrl,
      redirectCount: 0,
      inspectedBodyBytes: 0,
    };
    const original = {
      id: '00000000-0000-0000-0000-000000000001',
      monitorId: '00000000-0000-0000-0000-000000000002',
      configVersion: 1,
      status: ScheduledCheckStatus.PENDING,
      result: null,
      monitor: {
        id: '00000000-0000-0000-0000-000000000002',
        requestUrlEncrypted: encryptString(oldRequestUrl, encryptionKey),
        displayUrl: oldDisplayUrl,
        method: 'GET',
        timeoutMs: 5_000,
        expectedStatusMin: 200,
        expectedStatusMax: 299,
        expectedKeyword: null,
        followRedirects: true,
        maxRedirects: 5,
        configVersion: 1,
        lifecycleStatus: MonitorLifecycle.ACTIVE,
        deletedAt: null,
      },
    };
    const currentMonitor = {
      id: original.monitorId,
      displayUrl: newDisplayUrl,
      configVersion: 2,
      lifecycleStatus: MonitorLifecycle.ACTIVE,
      deletedAt: null,
      healthState: MonitorHealth.PENDING,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failureStreakStartedAt: null,
      failureStreakFirstErrorType: null,
    };
    const createResult = vi.fn().mockResolvedValue({ id: 'result-1' });
    const transactionClient = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      scheduledCheck: {
        findUnique: vi.fn().mockResolvedValue({
          id: original.id,
          status: ScheduledCheckStatus.CANCELED,
          configVersion: 1,
          result: null,
        }),
        update: vi.fn(),
      },
      monitor: { findUniqueOrThrow: vi.fn().mockResolvedValue(currentMonitor) },
      checkResult: { create: createResult },
    };
    const client = {
      scheduledCheck: {
        findUnique: vi.fn().mockResolvedValue(original),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn().mockImplementation((callback) => callback(transactionClient)),
    } as unknown as PrismaClient;
    const runCheck = vi.fn().mockResolvedValue(result);
    const processor = new ScheduledCheckProcessor(
      {
        instanceId: 'worker-1',
        region: 'test',
        leaseMs: 60_000,
        encryptionKey,
        appBaseUrl: null,
      },
      client,
      runCheck,
    );

    await expect(
      processor.process({ scheduledCheckId: original.id, configVersion: 1 }),
    ).resolves.toEqual({ status: 'canceled' });

    expect(runCheck).toHaveBeenCalledWith(expect.objectContaining({ url: oldRequestUrl }));
    expect(createResult).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configVersion: 1,
        displayUrlSnapshot: oldDisplayUrl,
      }),
    });
    expect(createResult.mock.calls[0]?.[0].data.displayUrlSnapshot).not.toBe(newDisplayUrl);
    expect(normalizedSql(transactionClient.$queryRaw.mock.calls[0]?.[0])).toBe(
      'SELECT id FROM monitors WHERE id = ? FOR UPDATE',
    );
  });
});
