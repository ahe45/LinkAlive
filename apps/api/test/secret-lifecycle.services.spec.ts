import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  transaction: vi.fn(),
  channelFindMany: vi.fn(),
  tx: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
    incident: { updateMany: vi.fn() },
    monitor: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    monitorChannel: { deleteMany: vi.fn() },
    notificationChannel: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    notificationDelivery: { updateMany: vi.fn() },
    notificationOutbox: { updateMany: vi.fn() },
    scheduledCheck: { updateMany: vi.fn() },
  },
}));

const appConfig = vi.hoisted(() => ({
  adminUsername: 'test-admin',
  encryptionKey: Buffer.from('0123456789abcdef0123456789abcdef'),
}));

vi.mock('@linkalive/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@linkalive/database')>();
  return {
    ...actual,
    prisma: {
      $transaction: database.transaction,
      notificationChannel: { findMany: database.channelFindMany },
    },
  };
});

vi.mock('../src/common/config.js', () => ({
  getConfig: () => appConfig,
}));

import {
  IncidentClosureReason,
  IncidentStatus,
  MonitorLifecycle,
  NotificationOutboxStatus,
  ScheduledCheckStatus,
  isSecretTombstone,
} from '@linkalive/database';
import { MonitorsService } from '../src/monitors/monitors.service.js';
import { decryptJson, encryptJson } from '../src/common/crypto.js';
import { NotificationChannelsService } from '../src/notifications/notification-channels.service.js';

const monitorId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000002';
const originalChannelConfig = new Uint8Array([7, 8, 9]);
const channelRecord = {
  id: channelId,
  type: 'TELEGRAM',
  displayName: 'Operations',
  encryptedConfig: originalChannelConfig,
  enabled: true,
  verifiedAt: null,
  createdAt: new Date('2026-09-03T00:00:00.000Z'),
  updatedAt: new Date('2026-09-03T00:00:00.000Z'),
};

function expectTombstone(value: unknown): void {
  expect(value).toBeInstanceOf(Uint8Array);
  expect((value as Uint8Array).byteLength).toBeGreaterThan(0);
  expect(isSecretTombstone(value as Uint8Array)).toBe(true);
}

function normalizedSql(query: unknown): string {
  const sql = query as { strings: readonly string[] };
  return sql.strings.join('?').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  database.transaction.mockImplementation(async (operation: (tx: typeof database.tx) => unknown) =>
    operation(database.tx),
  );
  database.tx.$queryRaw.mockResolvedValue([{ id: monitorId }]);
  database.tx.monitor.findFirst.mockResolvedValue({ id: monitorId });
  database.tx.notificationChannel.findFirst.mockResolvedValue(channelRecord);
  database.tx.notificationChannel.update.mockResolvedValue(channelRecord);
});

describe('monitor secret lifecycle', () => {
  it('tombstones the URL and terminal outbox snapshots after canceling runtime work', async () => {
    await new MonitorsService().remove(monitorId);

    const lockSql = normalizedSql(database.tx.$queryRaw.mock.calls[0]?.[0]);
    expect(lockSql).toBe('SELECT id FROM monitors WHERE id = ? AND deleted_at IS NULL FOR UPDATE');
    expect(lockSql).not.toContain('::');

    const outboxCalls = database.tx.notificationOutbox.updateMany.mock.calls.map(
      ([request]) => request,
    );
    expect(outboxCalls).toHaveLength(2);
    expect(outboxCalls[0]).toMatchObject({
      where: {
        monitorId,
        status: {
          in: [
            NotificationOutboxStatus.PENDING,
            NotificationOutboxStatus.ENQUEUED,
            NotificationOutboxStatus.PROCESSING,
            NotificationOutboxStatus.RETRY,
          ],
        },
      },
      data: {
        status: NotificationOutboxStatus.CANCELED,
        canceledAt: expect.any(Date),
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    expect(outboxCalls[1]).toMatchObject({
      where: {
        monitorId,
        status: {
          in: [
            NotificationOutboxStatus.SENT,
            NotificationOutboxStatus.FAILED,
            NotificationOutboxStatus.CANCELED,
          ],
        },
      },
    });
    expectTombstone(outboxCalls[1]?.data.encryptedConfigSnapshot);
    expect(database.tx.notificationOutbox.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      database.tx.notificationOutbox.updateMany.mock.invocationCallOrder[1]!,
    );

    const monitorUpdate = database.tx.monitor.update.mock.calls[0]?.[0];
    expect(monitorUpdate).toMatchObject({
      where: { id: monitorId },
      data: {
        lifecycleStatus: MonitorLifecycle.DELETED,
        requestUrlEncrypted: expect.any(Uint8Array),
        deletedAt: expect.any(Date),
      },
    });
    expectTombstone(monitorUpdate?.data.requestUrlEncrypted);
    expect(database.tx.incident.updateMany).toHaveBeenCalledWith({
      where: { monitorId, status: IncidentStatus.OPEN },
      data: {
        status: IncidentStatus.CANCELED,
        canceledAt: expect.any(Date),
        closureReason: IncidentClosureReason.DELETED,
      },
    });
    expect(database.tx.scheduledCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          monitorId,
          status: {
            in: [
              ScheduledCheckStatus.PENDING,
              ScheduledCheckStatus.ENQUEUED,
              ScheduledCheckStatus.RUNNING,
            ],
          },
        },
      }),
    );
  });
});

describe('notification channel secret lifecycle', () => {
  it('returns decrypted connection values to the authenticated admin API', async () => {
    const telegramConfig = new TextEncoder().encode(
      encryptJson(
        { type: 'TELEGRAM', botToken: '123456:full-token', chatId: '-1001234567890' },
        appConfig.encryptionKey,
      ),
    );
    database.channelFindMany.mockResolvedValue([
      { ...channelRecord, encryptedConfig: telegramConfig },
    ]);

    const result = await new NotificationChannelsService().list(undefined, 20);

    expect(result.items[0]).toMatchObject({
      botToken: '123456:full-token',
      chatId: '-1001234567890',
    });
  });

  it('re-encrypts a changed Telegram destination and requires a new verification', async () => {
    const encryptedConfig = new TextEncoder().encode(
      encryptJson(
        { type: 'TELEGRAM', botToken: '123456:old-token', chatId: '-100111' },
        appConfig.encryptionKey,
      ),
    );
    database.tx.$queryRaw.mockResolvedValue([{ id: channelId }]);
    database.tx.notificationChannel.findFirst.mockResolvedValue({
      ...channelRecord,
      encryptedConfig,
      verifiedAt: new Date('2026-09-03T01:00:00.000Z'),
    });

    await new NotificationChannelsService().update(channelId, {
      botToken: '123456:new-token',
      chatId: '-100222',
    });

    const channelUpdate = database.tx.notificationChannel.update.mock.calls[0]?.[0];
    expect(channelUpdate).toMatchObject({
      where: { id: channelId },
      data: { encryptedConfig: expect.any(Uint8Array), verifiedAt: null },
    });
    const decoded = decryptJson<{ type: 'TELEGRAM'; botToken: string; chatId: string }>(
      new TextDecoder().decode(channelUpdate?.data.encryptedConfig),
      appConfig.encryptionKey,
    );
    expect(decoded).toEqual({
      type: 'TELEGRAM',
      botToken: '123456:new-token',
      chatId: '-100222',
    });
  });

  it('tombstones the channel config and terminal outbox snapshots when removed', async () => {
    database.tx.$queryRaw.mockResolvedValue([{ id: channelId }]);

    await new NotificationChannelsService().remove(channelId);

    const lockSql = normalizedSql(database.tx.$queryRaw.mock.calls[0]?.[0]);
    expect(lockSql).toBe(
      'SELECT id FROM notification_channels WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
    );
    expect(lockSql).not.toContain('NO KEY');

    const outboxCalls = database.tx.notificationOutbox.updateMany.mock.calls.map(
      ([request]) => request,
    );
    expect(outboxCalls).toHaveLength(2);
    expect(outboxCalls[0]).toMatchObject({
      where: {
        channelId,
        status: {
          in: [
            NotificationOutboxStatus.PENDING,
            NotificationOutboxStatus.ENQUEUED,
            NotificationOutboxStatus.PROCESSING,
            NotificationOutboxStatus.RETRY,
          ],
        },
      },
      data: {
        status: NotificationOutboxStatus.CANCELED,
        canceledAt: expect.any(Date),
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    expect(outboxCalls[1]).toMatchObject({
      where: {
        channelId,
        status: {
          in: [
            NotificationOutboxStatus.SENT,
            NotificationOutboxStatus.FAILED,
            NotificationOutboxStatus.CANCELED,
          ],
        },
      },
    });
    expectTombstone(outboxCalls[1]?.data.encryptedConfigSnapshot);

    const channelUpdate = database.tx.notificationChannel.update.mock.calls[0]?.[0];
    expect(channelUpdate).toMatchObject({
      where: { id: channelId },
      data: {
        enabled: false,
        encryptedConfig: expect.any(Uint8Array),
        deletedAt: expect.any(Date),
      },
    });
    expectTombstone(channelUpdate?.data.encryptedConfig);
  });

  it('redacts terminal outbox snapshots when disabled without replacing channel config', async () => {
    database.tx.$queryRaw.mockResolvedValue([{ id: channelId }]);

    await new NotificationChannelsService().update(channelId, { enabled: false });

    const outboxCalls = database.tx.notificationOutbox.updateMany.mock.calls.map(
      ([request]) => request,
    );
    expect(outboxCalls).toHaveLength(2);
    expectTombstone(outboxCalls[1]?.data.encryptedConfigSnapshot);

    const channelUpdate = database.tx.notificationChannel.update.mock.calls[0]?.[0];
    expect(channelUpdate).toEqual({
      where: { id: channelId },
      data: { enabled: false },
    });
    expect(channelUpdate?.data).not.toHaveProperty('encryptedConfig');
    expect(channelRecord.encryptedConfig).toBe(originalChannelConfig);
  });
});
