import {
  NotificationEventType,
  NotificationOutboxStatus,
  prisma,
  type Prisma,
  type PrismaClient,
} from '@linkalive/database';
import { Queue, type JobsOptions } from 'bullmq';

import { NOTIFICATION_JOB_NAME } from './constants.js';
import {
  DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
  recoveryPrerequisiteStatus,
} from './notification-order.js';
import { retiredNotificationSecretData } from './secret-lifecycle.js';

const RECOVERY_RECHECK_DELAY_MS = 2_000;
const DISPATCH_SCAN_MULTIPLIER = 5;
const MAX_DISPATCH_SCAN = 5_000;

function availableForDispatch(now: Date): Prisma.NotificationOutboxWhereInput {
  return {
    availableAt: { lte: now },
    OR: [
      {
        status: { in: [NotificationOutboxStatus.PENDING, NotificationOutboxStatus.RETRY] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      {
        status: {
          in: [NotificationOutboxStatus.ENQUEUED, NotificationOutboxStatus.PROCESSING],
        },
        leaseUntil: { lt: now },
      },
    ],
  };
}

export interface NotificationJobData {
  outboxId: string;
}

export interface NotificationQueuePort {
  getJob(id: string): Promise<
    | {
        getState(): Promise<string>;
        remove(): Promise<void>;
      }
    | undefined
  >;
  add(name: string, data: NotificationJobData, options: JobsOptions): Promise<unknown>;
}

async function ensureNotificationJob(
  queue: NotificationQueuePort,
  outboxId: string,
): Promise<void> {
  const existing = await queue.getJob(outboxId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') await existing.remove();
    else return;
  }
  await queue.add(
    NOTIFICATION_JOB_NAME,
    { outboxId },
    {
      jobId: outboxId,
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 50_000 },
    },
  );
}

export class NotificationOutboxDispatcher {
  constructor(
    private readonly queue: NotificationQueuePort,
    private readonly owner: string,
    private readonly leaseMs: number,
    private readonly client: PrismaClient = prisma,
  ) {}

  async dispatch(now = new Date(), limit = 200): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return 0;

    let dispatched = 0;
    let scanned = 0;
    const scanBudget = Math.max(
      limit,
      Math.min(MAX_DISPATCH_SCAN, limit * DISPATCH_SCAN_MULTIPLIER),
    );

    // A page can consist entirely of RECOVERY events whose DOWN event has not
    // reached a terminal state. Move those events' availability forward and
    // keep scanning so they cannot permanently hide ready work behind take().
    while (dispatched < limit && scanned < scanBudget) {
      const take = Math.min(limit - dispatched, scanBudget - scanned);
      const candidates = await this.client.notificationOutbox.findMany({
        where: availableForDispatch(now),
        include: { channel: { select: { enabled: true, deletedAt: true } } },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take,
      });
      if (candidates.length === 0) break;
      scanned += candidates.length;
      let batchMadeProgress = false;

      for (const candidate of candidates) {
        if (!candidate.channel.enabled || candidate.channel.deletedAt) {
          batchMadeProgress =
            (await this.cancel(candidate.id, now, '알림 채널이 비활성화되었습니다.')) ||
            batchMadeProgress;
          continue;
        }
        if (candidate.eventType === NotificationEventType.RECOVERY && candidate.incidentId) {
          const down = await this.client.notificationOutbox.findFirst({
            where: {
              incidentId: candidate.incidentId,
              channelId: candidate.channelId,
              eventType: NotificationEventType.DOWN,
            },
            select: { status: true },
          });
          const prerequisite = recoveryPrerequisiteStatus(down?.status ?? null);
          if (prerequisite === 'WAIT') {
            batchMadeProgress = (await this.deferRecovery(candidate.id, now)) || batchMadeProgress;
            continue;
          }
          if (prerequisite === 'CANCEL') {
            batchMadeProgress =
              (await this.cancel(
                candidate.id,
                now,
                DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
                down?.status === NotificationOutboxStatus.FAILED,
              )) || batchMadeProgress;
            continue;
          }
        }

        const leaseUntil = new Date(now.getTime() + this.leaseMs);
        const claimed = await this.client.notificationOutbox.updateMany({
          where: {
            id: candidate.id,
            ...availableForDispatch(now),
          },
          data: {
            status: NotificationOutboxStatus.RETRY,
            leaseOwner: this.owner,
            leaseUntil,
          },
        });
        if (claimed.count !== 1) continue;
        batchMadeProgress = true;
        try {
          await ensureNotificationJob(this.queue, candidate.id);
          await this.client.notificationOutbox.updateMany({
            where: {
              id: candidate.id,
              leaseOwner: this.owner,
              status: NotificationOutboxStatus.RETRY,
            },
            data: {
              status: NotificationOutboxStatus.ENQUEUED,
              queueJobId: candidate.id,
              enqueuedAt: now,
              leaseUntil,
            },
          });
          dispatched += 1;
        } catch {
          await this.client.notificationOutbox.updateMany({
            where: {
              id: candidate.id,
              leaseOwner: this.owner,
              status: NotificationOutboxStatus.RETRY,
            },
            data: {
              status: NotificationOutboxStatus.RETRY,
              availableAt: new Date(now.getTime() + 2_000),
              leaseOwner: null,
              leaseUntil: null,
              lastErrorSafe: '알림 큐에 작업을 등록하지 못했습니다.',
            },
          });
        }
      }

      // A concurrent dispatcher may have claimed every row in this page. Do
      // not spin on the same stale read if this worker changed nothing.
      if (!batchMadeProgress) break;
    }
    return dispatched;
  }

  private async deferRecovery(id: string, now: Date): Promise<boolean> {
    const deferred = await this.client.notificationOutbox.updateMany({
      where: {
        id,
        ...availableForDispatch(now),
      },
      data: { availableAt: new Date(now.getTime() + RECOVERY_RECHECK_DELAY_MS) },
    });
    return deferred.count === 1;
  }

  private async cancel(
    id: string,
    now: Date,
    reason: string,
    retainForLateDownSuccess = false,
  ): Promise<boolean> {
    const canceled = await this.client.notificationOutbox.updateMany({
      where: {
        id,
        ...availableForDispatch(now),
      },
      data: {
        status: NotificationOutboxStatus.CANCELED,
        canceledAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastErrorSafe: reason,
        ...(retainForLateDownSuccess ? {} : retiredNotificationSecretData()),
      },
    });
    return canceled.count === 1;
  }
}

export function asNotificationQueue(queue: Queue<NotificationJobData>): NotificationQueuePort {
  return queue;
}
