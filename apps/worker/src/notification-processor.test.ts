import { createCipheriv, randomBytes } from 'node:crypto';

import {
  IncidentStatus,
  isSecretTombstone,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationOutboxStatus,
  type PrismaClient,
} from '@linkalive/database';
import { describe, expect, it, vi } from 'vitest';

import {
  normalizeProviderMessageId,
  NotificationPersistenceError,
  NotificationProcessor,
} from './notification-processor.js';
import { DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON } from './notification-order.js';

function normalizedSql(query: unknown): string {
  const sql = query as { strings: readonly string[] };
  return sql.strings.join('?').replace(/\s+/g, ' ').trim();
}

function encryptJson(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.from(
    [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.'),
  );
}

function createProcessor(
  client: PrismaClient,
  encryptionKey = randomBytes(32),
  providerMessageId = 'provider-1',
) {
  return new NotificationProcessor(
    { instanceId: 'worker-1', leaseMs: 60_000, encryptionKey },
    {
      telegram: {
        send: vi.fn().mockResolvedValue({
          messageId: '<linkalive-stable@example.com>',
          providerMessageId,
        }),
      } as never,
    },
    client,
  );
}

describe('NotificationProcessor persistence recovery', () => {
  it('bounds and sanitizes a diagnostic provider Message-ID before persistence', () => {
    const normalized = normalizeProviderMessageId(`\r\n${'😀'.repeat(600)}\u0000`);

    expect(normalized).not.toBeNull();
    expect(Array.from(normalized ?? '')).toHaveLength(512);
    expect(normalized).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(normalizeProviderMessageId('\u0000\r\n')).toBeNull();
  });

  it('commits SENT after an adapter returns an oversized provider Message-ID', async () => {
    const encryptionKey = randomBytes(32);
    const deliveryUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      notificationDelivery: { update: deliveryUpdate },
      notificationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const client = {
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient;
    const processor = createProcessor(client, encryptionKey, `\r\n${'x'.repeat(600)}\u0000`);
    const internal = processor as unknown as { claim: ReturnType<typeof vi.fn> };
    internal.claim = vi.fn().mockResolvedValue({
      id: 'outbox-1',
      deliveryId: 'delivery-1',
      deliveryAttempt: 1,
      maxAttempts: 3,
      eventType: NotificationEventType.DOWN,
      payloadSafe: {
        eventType: NotificationEventType.DOWN,
        monitorName: 'API',
        displayUrl: 'https://example.com',
        occurredAt: '2026-09-03T00:00:00.000Z',
      },
      encryptedConfigSnapshot: encryptJson(
        { botToken: '123456:test-token', chatId: '-100123' },
        encryptionKey,
      ),
      channelTypeSnapshot: 'TELEGRAM',
      messageId: '<linkalive-stable@example.com>',
    });

    await expect(processor.process({ outboxId: 'outbox-1' })).resolves.toEqual({ status: 'sent' });
    expect(deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: expect.objectContaining({
        status: NotificationDeliveryStatus.SUCCEEDED,
        providerMessageId: 'x'.repeat(512),
      }),
    });
  });

  it('does not turn a provider-accepted notification into FAILED when markSent fails', async () => {
    const encryptionKey = randomBytes(32);
    const processor = createProcessor({} as PrismaClient, encryptionKey);
    const internal = processor as unknown as {
      claim: ReturnType<typeof vi.fn>;
      markSent: ReturnType<typeof vi.fn>;
      markFailed: ReturnType<typeof vi.fn>;
    };
    internal.claim = vi.fn().mockResolvedValue({
      id: 'outbox-1',
      deliveryId: 'delivery-1',
      deliveryAttempt: 1,
      maxAttempts: 3,
      eventType: NotificationEventType.DOWN,
      payloadSafe: {
        eventType: NotificationEventType.DOWN,
        monitorName: 'API',
        displayUrl: 'https://example.com',
        occurredAt: '2026-09-03T00:00:00.000Z',
      },
      encryptedConfigSnapshot: encryptJson(
        { botToken: '123456:test-token', chatId: '-100123' },
        encryptionKey,
      ),
      channelTypeSnapshot: 'TELEGRAM',
      messageId: '<linkalive-stable@example.com>',
    });
    internal.markSent = vi.fn().mockRejectedValue(new Error('database unavailable'));
    internal.markFailed = vi.fn();

    await expect(processor.process({ outboxId: 'outbox-1' })).rejects.toBeInstanceOf(
      NotificationPersistenceError,
    );
    expect(internal.markFailed).not.toHaveBeenCalled();
  });

  it('marks an expired attempt UNKNOWN and reuses the same Message-ID on lease recovery', async () => {
    const messageId = '<linkalive-stable@example.com>';
    const expiredOutbox = {
      id: '00000000-0000-0000-0000-000000000001',
      monitorId: '00000000-0000-0000-0000-000000000002',
      incidentId: '00000000-0000-0000-0000-000000000003',
      channelId: '00000000-0000-0000-0000-000000000004',
      eventType: NotificationEventType.DOWN,
      status: NotificationOutboxStatus.PROCESSING,
      availableAt: new Date('2026-09-03T00:00:00.000Z'),
      leaseUntil: new Date('2026-09-03T00:01:00.000Z'),
      attemptCount: 1,
      maxAttempts: 3,
      messageId,
      channel: { enabled: true, deletedAt: null },
    };
    const deliveryUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deliveryCreate = vi.fn().mockResolvedValue({ id: 'delivery-2' });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      notificationOutbox: {
        findUnique: vi.fn().mockResolvedValue(expiredOutbox),
        findFirst: vi.fn(),
        update: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...expiredOutbox,
            ...data,
            channel: undefined,
          }),
        ),
      },
      notificationDelivery: {
        updateMany: deliveryUpdateMany,
        create: deliveryCreate,
      },
    };
    const client = {
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient;
    const processor = createProcessor(client);
    const internal = processor as unknown as {
      claim(id: string): Promise<{ deliveryAttempt: number; messageId: string } | null>;
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:02:00.000Z'));
    try {
      const claimed = await internal.claim(expiredOutbox.id);
      expect(claimed).toEqual(expect.objectContaining({ deliveryAttempt: 2, messageId }));
    } finally {
      vi.useRealTimers();
    }

    expect(deliveryUpdateMany).toHaveBeenCalledWith({
      where: {
        outboxId: expiredOutbox.id,
        status: NotificationDeliveryStatus.ATTEMPTING,
      },
      data: {
        status: NotificationDeliveryStatus.UNKNOWN,
        errorSafe: '이전 발송 작업이 중단되어 전달 여부를 확인할 수 없습니다.',
        finishedAt: new Date('2026-09-03T00:02:00.000Z'),
      },
    });
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ attempt: 2, messageId }),
    });
    expect(normalizedSql(tx.$queryRaw.mock.calls[0]?.[0])).toBe(
      'SELECT id FROM notification_outbox WHERE id = ? FOR UPDATE',
    );
  });

  it('retires a terminal recovery snapshot after SENT is committed', async () => {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      notificationDelivery: { update: vi.fn().mockResolvedValue({}) },
      notificationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update,
      },
    };
    const processor = createProcessor({
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient);
    const internal = processor as unknown as {
      markSent(claimed: Record<string, unknown>, providerMessageId: string | null): Promise<void>;
    };

    await internal.markSent(
      {
        id: 'outbox-1',
        deliveryId: 'delivery-1',
        eventType: NotificationEventType.RECOVERY,
        incidentId: 'incident-1',
        payloadSafe: {},
      },
      'provider-1',
    );

    const tombstone = update.mock.calls[0]?.[0].data.encryptedConfigSnapshot as Uint8Array;
    expect(isSecretTombstone(tombstone)).toBe(true);
  });

  it('keeps a sent DOWN snapshot while its incident remains open', async () => {
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      notificationDelivery: { update: vi.fn().mockResolvedValue({}) },
      notificationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update,
      },
      incident: {
        findUnique: vi.fn().mockResolvedValue({ status: IncidentStatus.OPEN, resolvedAt: null }),
      },
    };
    const processor = createProcessor({
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    } as unknown as PrismaClient);
    const internal = processor as unknown as {
      markSent(claimed: Record<string, unknown>, providerMessageId: string | null): Promise<void>;
    };

    await internal.markSent(
      {
        id: 'outbox-1',
        deliveryId: 'delivery-1',
        eventType: NotificationEventType.DOWN,
        incidentId: 'incident-1',
        payloadSafe: { notifyOnRecovery: true },
      },
      'provider-1',
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('restores the original snapshot when late DOWN success reactivates recovery', async () => {
    const encryptedConfigSnapshot = Buffer.from('original-encrypted-config');
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      incident: {
        findUnique: vi.fn().mockResolvedValue({
          status: IncidentStatus.RESOLVED,
          resolvedAt: new Date('2026-09-03T00:05:00.000Z'),
        }),
      },
      notificationChannel: {
        findUnique: vi.fn().mockResolvedValue({ enabled: true, deletedAt: null }),
      },
      monitorChannel: {
        findFirst: vi.fn().mockResolvedValue({ monitorId: 'monitor-1' }),
      },
      notificationOutbox: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'recovery-1',
          eventType: NotificationEventType.RECOVERY,
          status: NotificationOutboxStatus.CANCELED,
          lastErrorSafe: DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
        }),
        update,
      },
    };
    const processor = createProcessor({} as PrismaClient);
    const internal = processor as unknown as {
      ensureRecoveryAfterLateDownSuccess(
        tx: Record<string, unknown>,
        down: Record<string, unknown>,
        now: Date,
      ): Promise<string | null>;
    };
    const now = new Date('2026-09-03T00:06:00.000Z');

    await expect(
      internal.ensureRecoveryAfterLateDownSuccess(
        tx,
        {
          id: 'down-1',
          eventType: NotificationEventType.DOWN,
          incidentId: 'incident-1',
          channelId: 'channel-1',
          monitorId: 'monitor-1',
          payloadSafe: { notifyOnRecovery: true },
          encryptedConfigSnapshot,
        },
        now,
      ),
    ).resolves.toBe(IncidentStatus.RESOLVED);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'recovery-1' },
      data: expect.objectContaining({
        status: NotificationOutboxStatus.PENDING,
        encryptedConfigSnapshot,
      }),
    });
  });
});
