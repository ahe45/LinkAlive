import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { prisma, type Prisma, type PrismaClient } from '@linkalive/database';
import type { MonitorCheckResult } from '@linkalive/monitoring';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { NetworkGuard } from '../src/network-guard.js';
import { ScheduledCheckProcessor } from '../src/check-processor.js';
import { NotificationProcessor, type NotificationAdapters } from '../src/notification-processor.js';

// Run with the production workers stopped or against an isolated test database.
const enabled = process.env.LINKALIVE_NETWORK_INTEGRATION === 'true';
const observerId = `network-integration-${randomUUID()}`;
const monitorId = randomUUID();
const channelId = randomUUID();
const encryptionKey = randomBytes(32);
let referenceOnline = false;
let targetOnline = false;
let guard: NetworkGuard;

function encrypt(value: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.from(
    [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.'),
  );
}

function result(online: boolean): MonitorCheckResult {
  return {
    source: 'SCHEDULED',
    outcome: online ? 'SUCCESS' : 'TARGET_FAILURE',
    configVersion: 1,
    startedAt: new Date(),
    finishedAt: new Date(),
    statusCode: online ? 200 : null,
    errorType: online ? null : 'CONNECT_TIMEOUT',
    errorMessageSafe: online ? null : 'timeout',
    totalMs: 1,
    ttfbMs: online ? 1 : null,
    finalUrlDisplay: 'https://network-integration.example/',
    redirectCount: 0,
    inspectedBodyBytes: 0,
  };
}

// Override only reference settings. Never overwrite the installation's settings.
const settingsReader = {
  findUnique: async () => ({
    id: 1,
    enabled: true,
    urls: ['https://reference-one.example/', 'https://reference-two.example/'],
    channelIds: [channelId],
    version: 1,
  }),
};
function withSettings<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key) {
      return key === 'networkSettings' ? settingsReader : Reflect.get(target, key);
    },
  });
}
const client = new Proxy(prisma, {
  get(target, key) {
    if (key === 'networkSettings') return settingsReader;
    if (key === '$transaction')
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        target.$transaction((tx) => callback(withSettings(tx)), options);
    return Reflect.get(target, key);
  },
}) as PrismaClient;

function makeGuard() {
  return new NetworkGuard(observerId, null, client, async () => result(referenceOnline));
}
async function check() {
  const scheduled = await prisma.scheduledCheck.create({
    data: { monitorId, scheduledAt: new Date(), configVersion: 1 },
  });
  const processor = new ScheduledCheckProcessor(
    { instanceId: observerId, region: 'test', leaseMs: 60_000, encryptionKey, appBaseUrl: null },
    client,
    async () => result(targetOnline),
    guard,
  );
  await processor.process({ scheduledCheckId: scheduled.id, configVersion: 1 });
  return prisma.checkResult.findFirstOrThrow({ where: { scheduledCheckId: scheduled.id } });
}

describe.runIf(enabled)('persisted monitoring network outage flow', () => {
  beforeAll(async () => {
    await prisma.monitor.create({
      data: {
        id: monitorId,
        name: observerId,
        requestUrlEncrypted: encrypt('https://network-integration.example/'),
        displayUrl: 'https://network-integration.example/',
        hostnameNormalized: 'network-integration.example',
        healthState: 'UP',
        failureThreshold: 1,
        recoveryThreshold: 2,
        nextCheckAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.notificationChannel.create({
      data: {
        id: channelId,
        type: 'TELEGRAM',
        displayName: observerId,
        encryptedConfig: encrypt(JSON.stringify({ botToken: 'test-only', chatId: 'test-only' })),
      },
    });
    guard = makeGuard();
  });

  afterAll(async () => {
    const outboxes = await prisma.notificationOutbox.findMany({
      where: { channelId },
      select: { id: true },
    });
    await prisma.notificationDelivery.deleteMany({
      where: { outboxId: { in: outboxes.map((item) => item.id) } },
    });
    await prisma.notificationOutbox.deleteMany({ where: { channelId } });
    await prisma.networkObservation.deleteMany({ where: { monitorId } });
    await prisma.networkOutage.deleteMany({ where: { observerId } });
    await prisma.networkObserver.deleteMany({ where: { id: observerId } });
    await prisma.incident.deleteMany({ where: { monitorId } });
    await prisma.checkResult.deleteMany({ where: { monitorId } });
    await prisma.scheduledCheck.deleteMany({ where: { monitorId } });
    await prisma.monitor.deleteMany({ where: { id: monitorId } });
    await prisma.notificationChannel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
  });

  it('suppresses false incidents, survives a worker restart and summarizes the recheck once', async () => {
    expect((await check()).outcome).toBe('INCONCLUSIVE');
    const monitor = await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } });
    expect(monitor.healthState).toBe('UP');
    expect(monitor.consecutiveFailures).toBe(0);
    expect(monitor.networkUnknownSince).not.toBeNull();
    expect(await prisma.incident.count({ where: { monitorId } })).toBe(0);
    guard = makeGuard();
    await guard.tick();
    expect(await prisma.networkOutage.count({ where: { observerId } })).toBe(1);
    referenceOnline = true;
    targetOnline = true;
    await guard.tick();
    expect(await prisma.notificationOutbox.count({ where: { channelId } })).toBe(0);
    expect((await check()).outcome).toBe('SUCCESS');
    await guard.tick();
    await guard.tick();
    const summaries = await prisma.notificationOutbox.findMany({ where: { channelId } });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ eventType: 'NETWORK_RECOVERY', monitorId: null });
    expect(summaries[0]?.payloadSafe).toMatchObject({
      errorMessageSafe: expect.stringContaining('정상 응답 1개'),
    });
    let sends = 0;
    const notifications = new NotificationProcessor(
      { instanceId: observerId, leaseMs: 60_000, encryptionKey },
      {
        telegram: {
          send: async (_payload: unknown, _destination: unknown, messageId: string) => {
            sends += 1;
            return { messageId, providerMessageId: 'fake-network-summary' };
          },
        },
      } as unknown as NotificationAdapters,
      prisma,
    );
    await prisma.notificationOutbox.update({
      where: { id: summaries[0]!.id },
      data: { availableAt: new Date(0) },
    });
    await notifications.process({ outboxId: summaries[0]!.id });
    await notifications.process({ outboxId: summaries[0]!.id });
    expect(sends).toBe(1);
    expect(
      (await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: summaries[0]!.id } }))
        .status,
    ).toBe('SENT');
    expect(
      (await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } })).networkUnknownSince,
    ).toBeNull();
  });

  it('preserves a real open incident during a later PC outage and requires confirmed recovery', async () => {
    targetOnline = false;
    expect((await check()).outcome).toBe('TARGET_FAILURE');
    expect(await prisma.incident.count({ where: { monitorId, status: 'OPEN' } })).toBe(1);
    referenceOnline = false;
    await guard.tick();
    expect((await check()).outcome).toBe('INCONCLUSIVE');
    expect((await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } })).healthState).toBe(
      'DOWN',
    );
    expect(await prisma.incident.count({ where: { monitorId, status: 'OPEN' } })).toBe(1);
    referenceOnline = true;
    targetOnline = true;
    await guard.tick();
    await check();
    expect((await prisma.monitor.findUniqueOrThrow({ where: { id: monitorId } })).healthState).toBe(
      'RECOVERING',
    );
    expect(await prisma.incident.count({ where: { monitorId, status: 'OPEN' } })).toBe(1);
    await check();
    expect(await prisma.incident.count({ where: { monitorId, status: 'RESOLVED' } })).toBe(1);
  });
});
