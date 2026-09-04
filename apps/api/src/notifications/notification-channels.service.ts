import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationDeliveryStatus,
  NotificationOutboxStatus,
  Prisma,
  prisma,
  secretTombstoneBytes,
} from '@linkalive/database';
import {
  NotificationProviderError,
  TelegramNotificationAdapter,
  type SafeNotificationPayload,
} from '@linkalive/notifications';
import { getConfig } from '../common/config.js';
import { decryptJson, encryptJson } from '../common/crypto.js';
import type { NotificationChannelInput, NotificationChannelPatch } from './notification.schemas.js';

type StoredChannelConfig = { type: 'TELEGRAM'; botToken: string; chatId: string };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const CHANNEL_TEST_COOLDOWN_MS = 10_000;
const lastChannelTestAt = new Map<string, number>();

function enforceChannelTestCooldown(channelId: string): void {
  const now = Date.now();
  const previous = lastChannelTestAt.get(channelId);
  if (previous !== undefined && now - previous < CHANNEL_TEST_COOLDOWN_MS) {
    throw new HttpException(
      '같은 채널의 시험 알림은 잠시 후 다시 시도해 주세요.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  lastChannelTestAt.set(channelId, now);
}

function encodeConfig(config: StoredChannelConfig): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(encryptJson(config, getConfig().encryptionKey));
}

function decodeConfig(value: Uint8Array): StoredChannelConfig {
  return decryptJson<StoredChannelConfig>(textDecoder.decode(value), getConfig().encryptionKey);
}

async function lockChannel(tx: Prisma.TransactionClient, id: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM notification_channels
    WHERE id = ${id} AND deleted_at IS NULL
    FOR UPDATE
  `);
  if (locked.length === 0) return null;
  return tx.notificationChannel.findFirst({ where: { id, deletedAt: null } });
}

function channelView(channel: {
  id: string;
  type: string;
  displayName: string;
  encryptedConfig: Uint8Array;
  enabled: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  let config: StoredChannelConfig | null = null;
  try {
    config = decodeConfig(channel.encryptedConfig);
  } catch {
    config = null;
  }
  return {
    id: channel.id,
    type: channel.type,
    displayName: channel.displayName,
    botToken: channel.type === 'TELEGRAM' && config?.type === 'TELEGRAM' ? config.botToken : null,
    chatId: channel.type === 'TELEGRAM' && config?.type === 'TELEGRAM' ? config.chatId : null,
    enabled: channel.enabled,
    verifiedAt: channel.verifiedAt,
    lastTestedAt: channel.verifiedAt,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

@Injectable()
export class NotificationChannelsService {
  async list(cursor: string | undefined, limit: number) {
    const rows = await prisma.notificationChannel.findMany({
      where: { deletedAt: null, type: 'TELEGRAM' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map(channelView),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async create(input: NotificationChannelInput) {
    const appConfig = getConfig();
    const botToken = input.botToken || appConfig.telegramBotToken;
    if (!botToken) throw new BadRequestException('Telegram bot token을 입력해 주세요.');
    const stored: StoredChannelConfig = { type: 'TELEGRAM', botToken, chatId: input.chatId };

    const channel = await prisma.$transaction(async (tx) => {
      const created = await tx.notificationChannel.create({
        data: {
          type: input.type,
          displayName: input.displayName,
          encryptedConfig: encodeConfig(stored),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: appConfig.adminUsername,
          action: 'NOTIFICATION_CHANNEL_CREATED',
          targetType: 'NotificationChannel',
          targetId: created.id,
        },
      });
      return created;
    });
    return channelView(channel);
  }

  async update(id: string, patch: NotificationChannelPatch) {
    const channel = await prisma.$transaction(async (tx) => {
      const current = await lockChannel(tx, id);
      if (!current) throw new NotFoundException('알림 채널을 찾을 수 없습니다.');
      if (current.type !== 'TELEGRAM') {
        throw new NotFoundException('알림 채널을 찾을 수 없습니다.');
      }
      const destinationPatchProvided = patch.botToken !== undefined || patch.chatId !== undefined;
      let nextConfig: StoredChannelConfig | undefined;
      let destinationChanged = false;

      if (destinationPatchProvided) {
        const currentConfig = decodeConfig(current.encryptedConfig);
        if (currentConfig.type !== 'TELEGRAM') {
          throw new NotFoundException('알림 채널을 찾을 수 없습니다.');
        }
        nextConfig = currentConfig;
        const nextBotToken = patch.botToken ?? currentConfig.botToken;
        const nextChatId = patch.chatId ?? currentConfig.chatId;
        if (nextBotToken !== currentConfig.botToken || nextChatId !== currentConfig.chatId) {
          nextConfig = { type: 'TELEGRAM', botToken: nextBotToken, chatId: nextChatId };
          destinationChanged = true;
        }
      }
      const now = new Date();
      if (patch.enabled === false) {
        await tx.notificationDelivery.updateMany({
          where: {
            status: NotificationDeliveryStatus.ATTEMPTING,
            outbox: { channelId: id, status: NotificationOutboxStatus.PROCESSING },
          },
          data: {
            status: NotificationDeliveryStatus.UNKNOWN,
            errorSafe: '채널 비활성화로 발송 추적이 종료되어 전달 여부를 확인할 수 없습니다.',
            finishedAt: now,
          },
        });
        await tx.monitorChannel.deleteMany({ where: { channelId: id } });
        await tx.notificationOutbox.updateMany({
          where: {
            channelId: id,
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
            canceledAt: now,
            leaseOwner: null,
            leaseUntil: null,
          },
        });
        await this.retireTerminalOutboxSecrets(tx, id);
      }
      const updated = await tx.notificationChannel.update({
        where: { id },
        data: {
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(destinationChanged
            ? { encryptedConfig: encodeConfig(nextConfig!), verifiedAt: null }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'NOTIFICATION_CHANNEL_UPDATED',
          targetType: 'NotificationChannel',
          targetId: id,
        },
      });
      return updated;
    });
    return channelView(channel);
  }

  async remove(id: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const current = await lockChannel(tx, id);
      if (!current) throw new NotFoundException('알림 채널을 찾을 수 없습니다.');
      const now = new Date();
      await tx.notificationDelivery.updateMany({
        where: {
          status: NotificationDeliveryStatus.ATTEMPTING,
          outbox: { channelId: id, status: NotificationOutboxStatus.PROCESSING },
        },
        data: {
          status: NotificationDeliveryStatus.UNKNOWN,
          errorSafe: '채널 삭제로 발송 추적이 종료되어 전달 여부를 확인할 수 없습니다.',
          finishedAt: now,
        },
      });
      await tx.monitorChannel.deleteMany({ where: { channelId: id } });
      await tx.notificationOutbox.updateMany({
        where: {
          channelId: id,
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
          canceledAt: now,
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      await this.retireTerminalOutboxSecrets(tx, id);
      await tx.notificationChannel.update({
        where: { id },
        data: {
          enabled: false,
          encryptedConfig: secretTombstoneBytes(),
          deletedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'NOTIFICATION_CHANNEL_DELETED',
          targetType: 'NotificationChannel',
          targetId: id,
        },
      });
    });
  }

  async test(id: string): Promise<{ ok: true }> {
    const channel = await this.find(id);
    enforceChannelTestCooldown(id);
    const stored = decodeConfig(channel.encryptedConfig);
    const payload: SafeNotificationPayload = {
      eventType: 'TEST',
      monitorName: 'LinkAlive 테스트',
      displayUrl: 'https://example.com/health',
      occurredAt: new Date(),
      errorMessageSafe: '알림 채널이 정상적으로 연결되었습니다.',
    };
    const messageId = `<test.${channel.id}.${Date.now()}@linkalive.local>`;
    try {
      await new TelegramNotificationAdapter().send(
        payload,
        { botToken: stored.botToken, chatId: stored.chatId },
        messageId,
      );
    } catch (error) {
      const message =
        error instanceof NotificationProviderError
          ? error.safeMessage
          : '알림 시험 발송에 실패했습니다.';
      await prisma.auditLog
        .create({
          data: {
            actorId: getConfig().adminUsername,
            action: 'NOTIFICATION_CHANNEL_TEST_FAILED',
            targetType: 'NotificationChannel',
            targetId: id,
          },
        })
        .catch(() => undefined);
      throw new BadGatewayException(message);
    }

    await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notificationChannel.update({ where: { id }, data: { verifiedAt: now } });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'NOTIFICATION_CHANNEL_TEST_SUCCEEDED',
          targetType: 'NotificationChannel',
          targetId: id,
        },
      });
    });
    return { ok: true };
  }

  private async find(id: string) {
    const channel = await prisma.notificationChannel.findFirst({
      where: { id, deletedAt: null, type: 'TELEGRAM' },
    });
    if (!channel) throw new NotFoundException('알림 채널을 찾을 수 없습니다.');
    return channel;
  }

  private async retireTerminalOutboxSecrets(
    tx: Prisma.TransactionClient,
    channelId: string,
  ): Promise<void> {
    // A disabled/deleted channel can never emit a recovery, including the
    // special recovery row kept for a provider-confirmed late DOWN success.
    await tx.notificationOutbox.updateMany({
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
      data: { encryptedConfigSnapshot: secretTombstoneBytes() },
    });
  }
}
