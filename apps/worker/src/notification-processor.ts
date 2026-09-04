import {
  IncidentStatus,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationOutboxStatus,
  Prisma,
  prisma,
  type PrismaClient,
} from '@linkalive/database';
import { createNotificationDedupeKey, notificationSequence } from '@linkalive/domain';
import {
  createStableMessageId,
  NotificationProviderError,
  TelegramNotificationAdapter,
  type SafeNotificationPayload,
  type TelegramDestination,
} from '@linkalive/notifications';

import { decryptJson } from './crypto.js';
import { DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON } from './notification-order.js';
import type { NotificationJobData } from './outbox-dispatcher.js';
import { parseNotificationPayload, payloadAllowsRecovery } from './notification-payload.js';
import { retryDelayMs } from './retry.js';
import {
  retiredNotificationSecretData,
  shouldRetainNotificationSecret,
} from './secret-lifecycle.js';

interface TelegramChannelConfig {
  botToken?: string;
  chatId?: string;
}

export interface NotificationProcessorConfig {
  instanceId: string;
  leaseMs: number;
  encryptionKey: Buffer;
}

export interface NotificationAdapters {
  telegram: TelegramNotificationAdapter;
}

export class NotificationPersistenceError extends Error {
  constructor(cause: unknown) {
    super('The provider accepted the notification, but its SENT state could not be persisted.', {
      cause,
    });
    this.name = 'NotificationPersistenceError';
  }
}

type ClaimedNotification = Prisma.NotificationOutboxGetPayload<Record<string, never>> & {
  deliveryId: string;
  deliveryAttempt: number;
};
type Tx = Prisma.TransactionClient;
const MAX_PROVIDER_MESSAGE_ID_LENGTH = 512;

/** Provider IDs are diagnostic only; they must never make the SENT transaction fail. */
export function normalizeProviderMessageId(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, MAX_PROVIDER_MESSAGE_ID_LENGTH).join('');
}

function configError(message: string): NotificationProviderError {
  return new NotificationProviderError({
    code: 'INVALID_CHANNEL_CONFIG',
    retryable: false,
    safeMessage: message,
  });
}

function telegramDestination(value: unknown): TelegramDestination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('Telegram 채널 설정을 읽을 수 없습니다.');
  }
  const config = value as TelegramChannelConfig;
  if (typeof config.botToken !== 'string' || typeof config.chatId !== 'string') {
    throw configError('Telegram bot 또는 채팅 대상이 설정되어 있지 않습니다.');
  }
  return { botToken: config.botToken, chatId: config.chatId };
}

export class NotificationProcessor {
  constructor(
    private readonly config: NotificationProcessorConfig,
    private readonly adapters: NotificationAdapters,
    private readonly client: PrismaClient = prisma,
  ) {}

  async process(
    data: NotificationJobData,
  ): Promise<{ status: 'sent' | 'retry' | 'failed' | 'ignored' }> {
    const claimed = await this.claim(data.outboxId);
    if (!claimed) return { status: 'ignored' };
    const payload = parseNotificationPayload(
      claimed.payloadSafe,
      claimed.eventType as SafeNotificationPayload['eventType'],
    );

    let providerMessageId: string | null;
    try {
      const channelConfig = decryptJson(claimed.encryptedConfigSnapshot, this.config.encryptionKey);
      if (claimed.channelTypeSnapshot === 'TELEGRAM') {
        ({ providerMessageId } = await this.adapters.telegram.send(
          payload,
          telegramDestination(channelConfig),
          claimed.messageId,
        ));
      } else {
        throw configError('지원하지 않는 알림 채널입니다.');
      }
    } catch (error) {
      const providerError =
        error instanceof NotificationProviderError
          ? error
          : new NotificationProviderError({
              code: 'NOTIFICATION_INTERNAL_ERROR',
              retryable: false,
              safeMessage: '알림을 안전하게 처리하지 못했습니다.',
              cause: error,
            });
      return this.markFailed(claimed, providerError);
    }

    try {
      await this.markSent(claimed, providerMessageId);
      return { status: 'sent' };
    } catch (error) {
      // The provider has already accepted the message. Do not overwrite that
      // fact with FAILED. Keeping PROCESSING + ATTEMPTING until lease expiry
      // lets claim() mark the attempt UNKNOWN and retry with the outbox's
      // stable Message-ID.
      throw new NotificationPersistenceError(error);
    }
  }

  private async claim(id: string): Promise<ClaimedNotification | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.config.leaseMs);
    return this.client.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM notification_outbox WHERE id = ${id} FOR UPDATE`,
        );
        const outbox = await tx.notificationOutbox.findUnique({
          where: { id },
          include: { channel: { select: { enabled: true, deletedAt: true } } },
        });
        if (!outbox) return null;
        if (!outbox.channel.enabled || outbox.channel.deletedAt) {
          if (
            outbox.status !== NotificationOutboxStatus.SENT &&
            outbox.status !== NotificationOutboxStatus.FAILED &&
            outbox.status !== NotificationOutboxStatus.CANCELED
          ) {
            await tx.notificationOutbox.update({
              where: { id },
              data: {
                status: NotificationOutboxStatus.CANCELED,
                canceledAt: now,
                leaseOwner: null,
                leaseUntil: null,
                lastErrorSafe: '알림 채널이 비활성화되었습니다.',
                ...retiredNotificationSecretData(),
              },
            });
          } else {
            await tx.notificationOutbox.update({
              where: { id },
              data: retiredNotificationSecretData(),
            });
          }
          return null;
        }
        if (
          outbox.status !== NotificationOutboxStatus.PENDING &&
          outbox.status !== NotificationOutboxStatus.RETRY &&
          outbox.status !== NotificationOutboxStatus.ENQUEUED
        ) {
          if (
            outbox.status !== NotificationOutboxStatus.PROCESSING ||
            !outbox.leaseUntil ||
            outbox.leaseUntil >= now
          )
            return null;
        }
        if (
          (outbox.status === NotificationOutboxStatus.PENDING ||
            outbox.status === NotificationOutboxStatus.RETRY) &&
          outbox.availableAt > now
        ) {
          return null;
        }
        // A previous process may have stopped after the provider accepted the
        // message but before the DB commit. Preserve that uncertainty, then
        // retry with the exact same Message-ID.
        await tx.notificationDelivery.updateMany({
          where: { outboxId: id, status: NotificationDeliveryStatus.ATTEMPTING },
          data: {
            status: NotificationDeliveryStatus.UNKNOWN,
            errorSafe: '이전 발송 작업이 중단되어 전달 여부를 확인할 수 없습니다.',
            finishedAt: now,
          },
        });
        if (outbox.eventType === NotificationEventType.RECOVERY && outbox.incidentId) {
          const down = await tx.notificationOutbox.findFirst({
            where: {
              incidentId: outbox.incidentId,
              channelId: outbox.channelId,
              eventType: NotificationEventType.DOWN,
            },
            select: { status: true },
          });
          if (down?.status !== NotificationOutboxStatus.SENT) return null;
        }
        if (outbox.attemptCount >= outbox.maxAttempts) {
          await tx.notificationOutbox.update({
            where: { id },
            data: {
              status: NotificationOutboxStatus.FAILED,
              failedAt: now,
              leaseOwner: null,
              leaseUntil: null,
              lastErrorSafe: '최대 알림 발송 횟수를 초과했습니다.',
              ...retiredNotificationSecretData(),
            },
          });
          if (outbox.eventType === NotificationEventType.DOWN && outbox.incidentId) {
            await tx.notificationOutbox.updateMany({
              where: {
                incidentId: outbox.incidentId,
                channelId: outbox.channelId,
                eventType: NotificationEventType.RECOVERY,
                status: {
                  in: [
                    NotificationOutboxStatus.PENDING,
                    NotificationOutboxStatus.RETRY,
                    NotificationOutboxStatus.ENQUEUED,
                  ],
                },
              },
              data: {
                status: NotificationOutboxStatus.CANCELED,
                canceledAt: now,
                leaseOwner: null,
                leaseUntil: null,
                lastErrorSafe: DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
              },
            });
          }
          return null;
        }
        const deliveryAttempt = outbox.attemptCount + 1;
        const updated = await tx.notificationOutbox.update({
          where: { id },
          data: {
            status: NotificationOutboxStatus.PROCESSING,
            attemptCount: deliveryAttempt,
            processingAt: now,
            leaseOwner: this.config.instanceId,
            leaseUntil,
            lastErrorSafe: null,
          },
        });
        const delivery = await tx.notificationDelivery.create({
          data: {
            outboxId: id,
            attempt: deliveryAttempt,
            status: NotificationDeliveryStatus.ATTEMPTING,
            messageId: outbox.messageId,
            startedAt: now,
          },
        });
        return { ...updated, deliveryId: delivery.id, deliveryAttempt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async markSent(
    claimed: ClaimedNotification,
    providerMessageId: string | null,
  ): Promise<void> {
    const now = new Date();
    await this.client.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM notification_outbox WHERE id = ${claimed.id} FOR UPDATE`,
      );
      await tx.notificationDelivery.update({
        where: { id: claimed.deliveryId },
        data: {
          status: NotificationDeliveryStatus.SUCCEEDED,
          providerMessageId: normalizeProviderMessageId(providerMessageId),
          errorSafe: null,
          finishedAt: now,
          sentAt: now,
        },
      });
      // Any provider-confirmed attempt wins. A newer timed-out attempt must
      // not turn a confirmed SENT event back into RETRY/FAILED.
      const sent = await tx.notificationOutbox.updateMany({
        where: { id: claimed.id, status: { not: NotificationOutboxStatus.CANCELED } },
        data: {
          status: NotificationOutboxStatus.SENT,
          sentAt: now,
          failedAt: null,
          leaseOwner: null,
          leaseUntil: null,
          lastErrorSafe: null,
        },
      });
      if (sent.count === 1) {
        const incidentStatus = await this.ensureRecoveryAfterLateDownSuccess(tx, claimed, now);
        if (
          !shouldRetainNotificationSecret({
            status: NotificationOutboxStatus.SENT,
            eventType: claimed.eventType,
            lastErrorSafe: null,
            payloadAllowsRecovery: payloadAllowsRecovery(claimed.payloadSafe),
            incidentStatus,
          })
        ) {
          await tx.notificationOutbox.update({
            where: { id: claimed.id },
            data: retiredNotificationSecretData(),
          });
        }
      }
    });
  }

  private async ensureRecoveryAfterLateDownSuccess(
    tx: Tx,
    down: ClaimedNotification,
    now: Date,
  ): Promise<IncidentStatus | null> {
    if (
      down.eventType !== NotificationEventType.DOWN ||
      !down.incidentId ||
      !payloadAllowsRecovery(down.payloadSafe)
    ) {
      return null;
    }
    const incident = await tx.incident.findUnique({ where: { id: down.incidentId } });
    if (!incident || incident.status !== IncidentStatus.RESOLVED || !incident.resolvedAt) {
      return incident?.status ?? null;
    }
    const channel = await tx.notificationChannel.findUnique({
      where: { id: down.channelId },
      select: { enabled: true, deletedAt: true },
    });
    if (!channel?.enabled || channel.deletedAt) return incident.status;
    const binding = await tx.monitorChannel.findFirst({
      where: {
        monitorId: down.monitorId,
        channelId: down.channelId,
        notifyOnRecovery: true,
      },
      select: { monitorId: true },
    });
    if (!binding) return incident.status;

    const existing = await tx.notificationOutbox.findFirst({
      where: {
        incidentId: down.incidentId,
        channelId: down.channelId,
        sequence: notificationSequence(NotificationEventType.RECOVERY),
      },
    });
    if (existing) {
      if (
        existing.eventType === NotificationEventType.RECOVERY &&
        existing.status === NotificationOutboxStatus.CANCELED &&
        existing.lastErrorSafe === DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON
      ) {
        await tx.notificationOutbox.update({
          where: { id: existing.id },
          data: {
            status: NotificationOutboxStatus.PENDING,
            availableAt: now,
            canceledAt: null,
            queueJobId: null,
            enqueuedAt: null,
            leaseOwner: null,
            leaseUntil: null,
            lastErrorSafe: null,
            encryptedConfigSnapshot: down.encryptedConfigSnapshot,
          },
        });
      }
      return incident.status;
    }

    const monitor = await tx.monitor.findUnique({
      where: { id: down.monitorId },
      select: { lastStatusCode: true, lastTtfbMs: true },
    });
    const original = parseNotificationPayload(down.payloadSafe, NotificationEventType.DOWN);
    const payload: Prisma.InputJsonObject = {
      eventType: NotificationEventType.RECOVERY,
      monitorName: original.monitorName,
      displayUrl: original.displayUrl,
      occurredAt: incident.resolvedAt.toISOString(),
      errorType: incident.lastErrorType,
      errorMessageSafe: original.errorMessageSafe ?? null,
      statusCode: monitor?.lastStatusCode ?? null,
      ttfbMs: monitor?.lastTtfbMs ?? null,
      durationMs: Math.max(0, incident.resolvedAt.getTime() - incident.firstFailureAt.getTime()),
      notifyOnRecovery: true,
      ...(original.dashboardUrl ? { dashboardUrl: original.dashboardUrl } : {}),
    };
    const eventType = NotificationEventType.RECOVERY;
    const dedupeKey = createNotificationDedupeKey({
      incidentId: down.incidentId,
      channelId: down.channelId,
      eventType,
    });
    const messageDomain = /@([^>]+)>$/.exec(down.messageId)?.[1];
    await tx.notificationOutbox.create({
      data: {
        monitorId: down.monitorId,
        incidentId: down.incidentId,
        channelId: down.channelId,
        eventType,
        sequence: notificationSequence(eventType),
        dedupeKey,
        payloadSafe: payload,
        channelTypeSnapshot: down.channelTypeSnapshot,
        channelDisplayNameSnapshot: down.channelDisplayNameSnapshot,
        encryptedConfigSnapshot: down.encryptedConfigSnapshot,
        status: NotificationOutboxStatus.PENDING,
        messageId: createStableMessageId(dedupeKey, messageDomain),
      },
    });
    return incident.status;
  }

  private async markFailed(
    claimed: ClaimedNotification,
    error: NotificationProviderError,
  ): Promise<{ status: 'retry' | 'failed' }> {
    const now = new Date();
    const retry = error.retryable && claimed.deliveryAttempt < claimed.maxAttempts;
    const safeMessage = error.safeMessage.slice(0, 1_000);
    await this.client.$transaction(async (tx) => {
      await tx.notificationDelivery.update({
        where: { id: claimed.deliveryId },
        data: {
          status: error.deliveryUncertain
            ? NotificationDeliveryStatus.UNKNOWN
            : NotificationDeliveryStatus.FAILED,
          errorSafe: safeMessage,
          finishedAt: now,
        },
      });
      const currentAttempt = await tx.notificationOutbox.updateMany({
        where: {
          id: claimed.id,
          status: NotificationOutboxStatus.PROCESSING,
          attemptCount: claimed.deliveryAttempt,
        },
        data: retry
          ? {
              status: NotificationOutboxStatus.RETRY,
              availableAt: new Date(
                now.getTime() +
                  Math.max(error.retryAfterMs ?? 0, retryDelayMs(claimed.deliveryAttempt)),
              ),
              leaseOwner: null,
              leaseUntil: null,
              lastErrorSafe: safeMessage,
            }
          : {
              status: NotificationOutboxStatus.FAILED,
              failedAt: now,
              leaseOwner: null,
              leaseUntil: null,
              lastErrorSafe: safeMessage,
              ...retiredNotificationSecretData(),
            },
      });
      if (
        currentAttempt.count === 1 &&
        !retry &&
        claimed.eventType === NotificationEventType.DOWN &&
        claimed.incidentId
      ) {
        await tx.notificationOutbox.updateMany({
          where: {
            incidentId: claimed.incidentId,
            channelId: claimed.channelId,
            eventType: NotificationEventType.RECOVERY,
            status: {
              in: [
                NotificationOutboxStatus.PENDING,
                NotificationOutboxStatus.RETRY,
                NotificationOutboxStatus.ENQUEUED,
              ],
            },
          },
          data: {
            status: NotificationOutboxStatus.CANCELED,
            canceledAt: now,
            leaseOwner: null,
            leaseUntil: null,
            lastErrorSafe: DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
          },
        });
      }
    });
    return { status: retry ? 'retry' : 'failed' };
  }
}
