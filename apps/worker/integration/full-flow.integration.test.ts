import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';

import {
  CheckErrorType,
  CheckOutcome,
  CheckSource,
  IncidentStatus,
  MonitorHealth,
  MonitorLifecycle,
  NotificationEventType,
  NotificationOutboxStatus,
  prisma,
} from '@linkalive/database';
import { RedisDestinationLimiter, type MonitorCheckResult } from '@linkalive/monitoring';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CheckDispatcher, asCheckQueue } from '../../scheduler/src/check-dispatcher.js';
import { PrismaSchedulerStore } from '../../scheduler/src/store.js';
import { ScheduledCheckProcessor, type CheckRunner } from '../src/check-processor.js';
import { NotificationProcessor } from '../src/notification-processor.js';
import { NotificationOutboxDispatcher, asNotificationQueue } from '../src/outbox-dispatcher.js';

const integrationEnabled = process.env.LINKALIVE_INTEGRATION_TESTS === 'true';
const monitorId = randomUUID();
const channelId = randomUUID();
const checkQueueName = `linkalive-integration-check-${randomUUID()}`;
const notificationQueueName = `linkalive-integration-notification-${randomUUID()}`;
const encryptionKey = randomBytes(32);
const baseTime = new Date(Date.now() - 1_000);

let redis: Redis | undefined;
let checkQueue: Queue | undefined;
let notificationQueue: Queue | undefined;

function encrypt(value: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
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

function result(
  outcome: 'TARGET_FAILURE' | 'SUCCESS',
  configVersion: number | undefined,
  finishedAt: Date,
): MonitorCheckResult {
  const failed = outcome === 'TARGET_FAILURE';
  return {
    source: CheckSource.SCHEDULED,
    outcome: failed ? CheckOutcome.TARGET_FAILURE : CheckOutcome.SUCCESS,
    ...(configVersion === undefined ? {} : { configVersion }),
    startedAt: new Date(finishedAt.getTime() - 100),
    finishedAt,
    statusCode: failed ? 503 : 200,
    ttfbMs: 80,
    totalMs: 100,
    errorType: failed ? CheckErrorType.HTTP_STATUS_MISMATCH : null,
    errorMessageSafe: failed ? '기대 범위를 벗어난 HTTP 상태 코드(503)를 받았습니다.' : null,
    finalUrlDisplay: 'https://integration.example/health',
    redirectCount: 0,
    inspectedBodyBytes: 0,
  };
}

async function removeFixtureRows(): Promise<void> {
  const outboxes = await prisma.notificationOutbox.findMany({
    where: { monitorId },
    select: { id: true },
  });
  const outboxIds = outboxes.map(({ id }) => id);
  if (outboxIds.length > 0) {
    await prisma.notificationDelivery.deleteMany({ where: { outboxId: { in: outboxIds } } });
  }
  await prisma.notificationOutbox.deleteMany({ where: { monitorId } });
  await prisma.incident.deleteMany({ where: { monitorId } });
  await prisma.checkResult.deleteMany({ where: { monitorId } });
  await prisma.scheduledCheck.deleteMany({ where: { monitorId } });
  await prisma.monitorChannel.deleteMany({ where: { monitorId } });
  await prisma.monitor.deleteMany({ where: { id: monitorId } });
  await prisma.notificationChannel.deleteMany({ where: { id: channelId } });
}

describe.runIf(integrationEnabled)('MariaDB/MySQL + Redis scheduled outage flow', () => {
  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    checkQueue = new Queue(checkQueueName, { connection: redis });
    notificationQueue = new Queue(notificationQueueName, { connection: redis });
    await removeFixtureRows();

    await prisma.notificationChannel.create({
      data: {
        id: channelId,
        type: 'TELEGRAM',
        displayName: 'Integration Telegram',
        encryptedConfig: encrypt(
          JSON.stringify({ type: 'TELEGRAM', botToken: '123456:test-token', chatId: '-100123' }),
        ),
        enabled: true,
      },
    });
    await prisma.monitor.create({
      data: {
        id: monitorId,
        name: 'Integration monitor',
        requestUrlEncrypted: encrypt('https://integration.example/health'),
        displayUrl: 'https://integration.example/health',
        hostnameNormalized: 'integration.example',
        intervalSec: 60,
        timeoutMs: 3_000,
        failureThreshold: 1,
        recoveryThreshold: 1,
        lifecycleStatus: MonitorLifecycle.ACTIVE,
        healthState: MonitorHealth.PENDING,
        nextCheckAt: baseTime,
        channels: {
          create: {
            channelId,
            notifyOnDown: true,
            notifyOnRecovery: true,
          },
        },
      },
    });
  }, 30_000);

  afterAll(async () => {
    await removeFixtureRows().catch(() => undefined);
    await checkQueue?.obliterate({ force: true }).catch(() => undefined);
    await notificationQueue?.obliterate({ force: true }).catch(() => undefined);
    await Promise.allSettled([checkQueue?.close(), notificationQueue?.close()]);
    await redis?.quit().catch(() => undefined);
    await prisma.$disconnect();
  }, 30_000);

  it('applies the destination concurrency guard atomically in Redis', async () => {
    if (!redis) throw new Error('Integration Redis client was not created');
    const limiter = new RedisDestinationLimiter({
      client: {
        eval: async (script, numberOfKeys, ...args) => redis!.eval(script, numberOfKeys, ...args),
      },
      maxConcurrent: 1,
      maxPerMinute: 10,
      leaseMs: 45_000,
    });
    const destination = {
      url: new URL(`https://${monitorId}.integration.example/health`),
      addresses: [{ address: '93.184.216.34', family: 4 as const }],
    };

    const lease = await limiter.acquire(destination);
    await expect(limiter.acquire(destination)).rejects.toMatchObject({
      outcome: CheckOutcome.PLATFORM_ERROR,
      errorType: CheckErrorType.PLATFORM_ERROR,
    });
    await lease.release();
    const nextLease = await limiter.acquire(destination);
    await nextLease.release();
  });

  it('persists DOWN, sends it, then persists and sends RECOVERY without duplicate incidents', async () => {
    if (!checkQueue || !notificationQueue) throw new Error('Integration queues were not created');

    const outcomes: Array<'TARGET_FAILURE' | 'SUCCESS'> = ['TARGET_FAILURE', 'SUCCESS'];
    const runCheck: CheckRunner = vi.fn(async (config) => {
      const outcome = outcomes.shift();
      if (!outcome) throw new Error('Unexpected third scheduled check');
      const finishedAt =
        outcome === 'TARGET_FAILURE'
          ? new Date(baseTime.getTime() + 1_000)
          : new Date(baseTime.getTime() + 61_000);
      return result(outcome, config.configVersion, finishedAt);
    });
    const store = new PrismaSchedulerStore(prisma);
    const checkDispatcher = new CheckDispatcher(
      store,
      asCheckQueue(checkQueue),
      'integration-scheduler',
      60_000,
    );
    const checkProcessor = new ScheduledCheckProcessor(
      {
        instanceId: 'integration-worker',
        region: 'integration',
        leaseMs: 60_000,
        encryptionKey,
        appBaseUrl: 'http://localhost:3001',
        messageIdDomain: 'integration.test',
      },
      prisma,
      runCheck,
    );
    const outboxDispatcher = new NotificationOutboxDispatcher(
      asNotificationQueue(notificationQueue),
      'integration-outbox',
      60_000,
      prisma,
    );
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: '<stable@integration.test>',
      providerMessageId: 'integration-provider-id',
    });
    const notificationProcessor = new NotificationProcessor(
      { instanceId: 'integration-notifier', leaseMs: 60_000, encryptionKey },
      {
        telegram: { send: sendTelegram } as never,
      },
      prisma,
    );

    const first = await store.createDueChecks(baseTime, 10);
    expect(first).toHaveLength(1);
    expect(await checkDispatcher.dispatch(baseTime, 10)).toBe(1);
    expect(await checkQueue.getJob(first[0]!.id)).toBeDefined();
    await expect(
      checkProcessor.process({
        scheduledCheckId: first[0]!.id,
        configVersion: first[0]!.configVersion,
      }),
    ).resolves.toEqual({ status: 'completed' });

    const openIncident = await prisma.incident.findFirstOrThrow({ where: { monitorId } });
    expect(openIncident.status).toBe(IncidentStatus.OPEN);
    expect((await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } })).healthState).toBe(
      MonitorHealth.DOWN,
    );

    expect(await outboxDispatcher.dispatch(new Date(), 10)).toBe(1);
    const down = await prisma.notificationOutbox.findFirstOrThrow({
      where: { monitorId, eventType: NotificationEventType.DOWN },
    });
    await expect(notificationProcessor.process({ outboxId: down.id })).resolves.toEqual({
      status: 'sent',
    });

    const secondAt = new Date(baseTime.getTime() + 60_000);
    const second = await store.createDueChecks(secondAt, 10);
    expect(second).toHaveLength(1);
    expect(await checkDispatcher.dispatch(secondAt, 10)).toBe(1);
    await expect(
      checkProcessor.process({
        scheduledCheckId: second[0]!.id,
        configVersion: second[0]!.configVersion,
      }),
    ).resolves.toEqual({ status: 'completed' });

    expect(await outboxDispatcher.dispatch(new Date(), 10)).toBe(1);
    const recovery = await prisma.notificationOutbox.findFirstOrThrow({
      where: { monitorId, eventType: NotificationEventType.RECOVERY },
    });
    await expect(notificationProcessor.process({ outboxId: recovery.id })).resolves.toEqual({
      status: 'sent',
    });

    const [monitor, incident, outboxes, deliveries] = await Promise.all([
      prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } }),
      prisma.incident.findMany({ where: { monitorId } }),
      prisma.notificationOutbox.findMany({ where: { monitorId }, orderBy: { sequence: 'asc' } }),
      prisma.notificationDelivery.findMany({
        where: { outbox: { monitorId } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    expect(monitor.healthState).toBe(MonitorHealth.UP);
    expect(incident).toHaveLength(1);
    expect(incident[0]).toMatchObject({
      id: openIncident.id,
      status: IncidentStatus.RESOLVED,
    });
    expect(outboxes.map(({ eventType, status }) => ({ eventType, status }))).toEqual([
      { eventType: NotificationEventType.DOWN, status: NotificationOutboxStatus.SENT },
      { eventType: NotificationEventType.RECOVERY, status: NotificationOutboxStatus.SENT },
    ]);
    expect(deliveries).toHaveLength(2);
    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(runCheck).toHaveBeenCalledTimes(2);
  }, 30_000);
});
