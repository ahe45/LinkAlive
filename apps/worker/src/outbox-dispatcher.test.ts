import {
  isSecretTombstone,
  NotificationEventType,
  NotificationOutboxStatus,
  type PrismaClient,
} from '@linkalive/database';
import { describe, expect, it, vi } from 'vitest';

import { NotificationOutboxDispatcher, type NotificationQueuePort } from './outbox-dispatcher.js';

describe('NotificationOutboxDispatcher', () => {
  it('defers a waiting recovery and scans past a full first page for ready work', async () => {
    const now = new Date('2026-09-03T00:00:00.000Z');
    const waitingRecovery = {
      id: 'waiting-recovery',
      incidentId: 'incident-1',
      channelId: 'channel-1',
      eventType: NotificationEventType.RECOVERY,
      channel: { enabled: true, deletedAt: null },
    };
    const readyDown = {
      id: 'ready-down',
      incidentId: 'incident-2',
      channelId: 'channel-1',
      eventType: NotificationEventType.DOWN,
      channel: { enabled: true, deletedAt: null },
    };
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([waitingRecovery])
      .mockResolvedValueOnce([readyDown]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = {
      notificationOutbox: {
        findMany,
        findFirst: vi.fn().mockResolvedValue({ status: NotificationOutboxStatus.PROCESSING }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const queue: NotificationQueuePort = {
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
    };

    const dispatched = await new NotificationOutboxDispatcher(
      queue,
      'dispatcher-1',
      60_000,
      client,
    ).dispatch(now, 1);

    expect(dispatched).toBe(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      { outboxId: readyDown.id },
      expect.objectContaining({ jobId: readyDown.id }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: waitingRecovery.id }),
        data: {
          availableAt: new Date(now.getTime() + 2_000),
        },
      }),
    );
  });

  it('retires the config snapshot when a disabled channel cancels dispatch', async () => {
    const now = new Date('2026-09-03T00:00:00.000Z');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = {
      notificationOutbox: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'disabled-outbox',
              incidentId: 'incident-1',
              channelId: 'channel-1',
              eventType: NotificationEventType.DOWN,
              channel: { enabled: false, deletedAt: null },
            },
          ])
          .mockResolvedValueOnce([]),
        findFirst: vi.fn(),
        updateMany,
      },
    } as unknown as PrismaClient;
    const queue: NotificationQueuePort = {
      getJob: vi.fn(),
      add: vi.fn(),
    };

    await expect(
      new NotificationOutboxDispatcher(queue, 'dispatcher-1', 60_000, client).dispatch(now, 1),
    ).resolves.toBe(0);

    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data.status).toBe(NotificationOutboxStatus.CANCELED);
    expect(isSecretTombstone(data.encryptedConfigSnapshot)).toBe(true);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps a canceled recovery snapshot while a failed DOWN can still succeed late', async () => {
    const now = new Date('2026-09-03T00:00:00.000Z');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = {
      notificationOutbox: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'recovery-1',
              incidentId: 'incident-1',
              channelId: 'channel-1',
              eventType: NotificationEventType.RECOVERY,
              channel: { enabled: true, deletedAt: null },
            },
          ])
          .mockResolvedValueOnce([]),
        findFirst: vi.fn().mockResolvedValue({ status: NotificationOutboxStatus.FAILED }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const queue: NotificationQueuePort = {
      getJob: vi.fn(),
      add: vi.fn(),
    };

    await expect(
      new NotificationOutboxDispatcher(queue, 'dispatcher-1', 60_000, client).dispatch(now, 1),
    ).resolves.toBe(0);

    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      status: NotificationOutboxStatus.CANCELED,
      lastErrorSafe: '장애 알림이 전달되지 않아 복구 알림을 취소했습니다.',
    });
    expect(data).not.toHaveProperty('encryptedConfigSnapshot');
  });
});
