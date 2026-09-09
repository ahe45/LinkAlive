import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { hostname } from 'node:os';
import { checkReferenceUrls } from '@linkalive/monitoring';
import { prisma } from '@linkalive/database';
import type { NetworkSettingsInput, NetworkTestInput } from './network.schemas.js';
import { getConfig } from '../common/config.js';
import { decryptJson } from '../common/crypto.js';

export function networkChannelView(channel: {
  id: string;
  displayName: string;
  encryptedConfig: Uint8Array;
}) {
  let chatId: string | null = null;
  try {
    const config = decryptJson<{ chatId?: unknown }>(
      new TextDecoder('utf-8', { fatal: true }).decode(channel.encryptedConfig),
      getConfig().encryptionKey,
    );
    if (typeof config.chatId === 'string') chatId = config.chatId;
  } catch {
    /* The selector stays usable without exposing an unreadable configuration. */
  }
  return { id: channel.id, displayName: channel.displayName, chatId };
}

@Injectable()
export class NetworkService {
  private testing = false;

  async test(input: NetworkTestInput) {
    if (this.testing)
      throw new HttpException(
        '연결 테스트가 진행 중입니다. 완료 후 다시 시도해 주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.testing = true;
    try {
      const results = await checkReferenceUrls(input.urls);
      return {
        checkedFrom: hostname(),
        checkedAt: new Date(),
        results: results.map((result, index) => ({
          url: input.urls[index]!,
          reachable: result.statusCode !== null,
          statusCode: result.statusCode,
          totalMs: result.totalMs,
          errorType: result.errorType,
          errorMessage: result.errorMessageSafe ?? null,
        })),
      };
    } finally {
      this.testing = false;
    }
  }

  async get() {
    const [settings, observers, outages, channels] = await Promise.all([
      prisma.networkSettings.findUnique({ where: { id: 1 } }),
      prisma.networkObserver.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 }),
      prisma.networkOutage.findMany({
        orderBy: { startedAt: 'desc' },
        take: 30,
        include: { _count: { select: { observations: true } } },
      }),
      prisma.notificationChannel.findMany({
        where: { enabled: true, deletedAt: null, type: 'TELEGRAM' },
        select: { id: true, displayName: true, encryptedConfig: true },
        orderBy: { displayName: 'asc' },
      }),
    ]);
    return {
      settings: settings
        ? {
            enabled: settings.enabled,
            urls: settings.urls,
            channelIds: settings.channelIds,
            version: settings.version,
          }
        : { enabled: false, urls: [], channelIds: [], version: 0 },
      observers,
      outages,
      channels: channels.map(networkChannelView),
    };
  }

  async save(input: NetworkSettingsInput, actorId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.networkSettings.upsert({
        where: { id: 1 },
        create: { id: 1, urls: [], channelIds: [], version: 0 },
        update: {},
      });
      const channels = await tx.notificationChannel.count({
        where: { id: { in: input.channelIds }, enabled: true, deletedAt: null, type: 'TELEGRAM' },
      });
      if (channels !== input.channelIds.length)
        throw new BadRequestException('사용 가능한 Telegram 채널을 선택하세요.');
      const changed = await tx.networkSettings.updateMany({
        where: { id: 1, version: input.version },
        data: {
          enabled: input.enabled,
          urls: input.urls,
          channelIds: input.channelIds,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          '다른 관리자가 설정을 변경했습니다. 새로고침 후 다시 저장하세요.',
        );
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'network.settings.updated',
          targetType: 'NetworkSettings',
          targetId: '1',
          metadataSafe: {
            enabled: input.enabled,
            referenceCount: input.urls.length,
            channelCount: input.channelIds.length,
          },
        },
      });
    });
    return this.get();
  }
}
