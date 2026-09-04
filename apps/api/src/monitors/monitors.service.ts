import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IncidentClosureReason,
  IncidentStatus,
  MonitorHealth,
  MonitorLifecycle,
  NotificationDeliveryStatus,
  NotificationOutboxStatus,
  Prisma,
  ScheduledCheckStatus,
  prisma,
  secretTombstoneBytes,
} from '@linkalive/database';
import { calculateInitialNextCheckAt, isMonitorStale } from '@linkalive/domain';
import {
  CheckFailure,
  createHttpChecker,
  parseMonitorUrl,
  RedisDestinationLimiter,
  resolveSafeDestination,
  UrlPolicyError,
} from '@linkalive/monitoring';
import { getConfig } from '../common/config.js';
import { decryptString, encryptString } from '../common/crypto.js';
import { toDisplayUrl } from '../common/display.js';
import { getRedis } from '../common/redis.js';
import { parseInput } from '../common/validation.js';
import { monitorInputSchema, type MonitorInput, type MonitorPatch } from './monitor.schemas.js';
import {
  monitorInclude,
  toCheckResultView,
  toMonitorView,
  type MonitorRecord,
} from './monitor.view.js';

const CANCELABLE_CHECK_STATUSES: ScheduledCheckStatus[] = [
  ScheduledCheckStatus.PENDING,
  ScheduledCheckStatus.ENQUEUED,
  ScheduledCheckStatus.RUNNING,
];
const CANCELABLE_NOTIFICATION_STATUSES: NotificationOutboxStatus[] = [
  NotificationOutboxStatus.PENDING,
  NotificationOutboxStatus.ENQUEUED,
  NotificationOutboxStatus.PROCESSING,
  NotificationOutboxStatus.RETRY,
];
const MAX_STORED_URL_LENGTH = 2_048;
const MANUAL_CHECK_WINDOW_MS = 60_000;
const MANUAL_CHECKS_PER_WINDOW = 5;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type MonitorListState =
  'UP' | 'SUSPECT' | 'DOWN' | 'RECOVERING' | 'PENDING' | 'PAUSED' | 'STALE';

function staleMonitorWhere(now: Date): Prisma.MonitorWhereInput {
  return {
    lifecycleStatus: MonitorLifecycle.ACTIVE,
    // Every monitor uses a minimum five-minute stale grace period. This query
    // narrows the candidate set; the exact per-monitor interval is checked
    // before pagination in list().
    nextCheckAt: { lt: new Date(now.getTime() - 300_000) },
  };
}

export function buildMonitorListWhere(
  state?: MonitorListState,
  query?: string,
  now = new Date(),
): Prisma.MonitorWhereInput {
  const filters: Prisma.MonitorWhereInput[] = [{ deletedAt: null }];
  const stale = staleMonitorWhere(now);

  switch (state) {
    case 'PAUSED':
      filters.push({ lifecycleStatus: MonitorLifecycle.PAUSED });
      break;
    case 'STALE':
      filters.push(stale);
      break;
    case 'DOWN':
      filters.push({
        lifecycleStatus: MonitorLifecycle.ACTIVE,
        healthState: MonitorHealth.DOWN,
      });
      break;
    case 'RECOVERING':
      filters.push({
        lifecycleStatus: MonitorLifecycle.ACTIVE,
        healthState: MonitorHealth.RECOVERING,
      });
      break;
    case 'UP':
    case 'SUSPECT':
    case 'PENDING':
      filters.push({
        lifecycleStatus: MonitorLifecycle.ACTIVE,
        healthState: MonitorHealth[state],
      });
      break;
  }

  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    filters.push({
      OR: [{ name: { contains: normalizedQuery } }, { displayUrl: { contains: normalizedQuery } }],
    });
  }

  return { AND: filters };
}

async function assertChannelIds(
  client: Prisma.TransactionClient,
  channelIds: string[],
): Promise<void> {
  if (channelIds.length === 0) return;
  const count = await client.notificationChannel.count({
    where: { id: { in: channelIds }, type: 'TELEGRAM', enabled: true, deletedAt: null },
  });
  if (count !== new Set(channelIds).size) {
    throw new BadRequestException('사용할 수 없는 알림 채널이 포함되어 있습니다.');
  }
}

function parseTarget(rawUrl: string): URL {
  try {
    return parseMonitorUrl(rawUrl);
  } catch (error) {
    if (error instanceof CheckFailure) throw new BadRequestException(error.safeMessage);
    throw error;
  }
}

async function validateTarget(rawUrl: string): Promise<URL> {
  const parsed = parseTarget(rawUrl);

  try {
    await resolveSafeDestination(parsed);
  } catch (error) {
    // A currently broken DNS record is still a useful monitor. URL format
    // violations are rejected, while any resolvable HTTP(S) destination is accepted.
    if (error instanceof UrlPolicyError) throw new BadRequestException(error.safeMessage);
    if (!(error instanceof CheckFailure && error.errorType === 'DNS_ERROR')) throw error;
  }
  return parsed;
}

interface StoredTarget {
  requestUrl: string;
  displayUrl: string;
  hostnameNormalized: string;
}

function storedTarget(parsedUrl: URL): StoredTarget {
  const requestUrl = parsedUrl.toString();
  const displayUrl = toDisplayUrl(requestUrl);
  if (requestUrl.length > MAX_STORED_URL_LENGTH || displayUrl.length > MAX_STORED_URL_LENGTH) {
    throw new BadRequestException('정규화된 URL은 2,048자를 초과할 수 없습니다.');
  }
  return {
    requestUrl,
    displayUrl,
    hostnameNormalized: parsedUrl.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase(),
  };
}

function encryptedBytes(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(encryptString(value, getConfig().encryptionKey));
}

function decryptedUrl(value: Uint8Array): string {
  return decryptString(textDecoder.decode(value), getConfig().encryptionKey);
}

function checkConfig(monitor: MonitorRecordLike, source: 'MANUAL' | 'TEST') {
  const config = {
    url: monitor.url,
    method: monitor.method,
    timeoutMs: monitor.timeoutMs,
    expectedStatusMin: monitor.expectedStatusMin,
    expectedStatusMax: monitor.expectedStatusMax,
    expectedKeyword: monitor.expectedKeyword || null,
    followRedirects: monitor.followRedirects,
    maxRedirects: monitor.maxRedirects,
    source,
  } as const;
  return monitor.configVersion === undefined
    ? config
    : { ...config, configVersion: monitor.configVersion };
}

interface MonitorRecordLike {
  url: string;
  method: 'GET' | 'HEAD';
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
  expectedKeyword?: string | null;
  followRedirects: boolean;
  maxRedirects: number;
  configVersion?: number;
}

const configFields = [
  'url',
  'method',
  'intervalSec',
  'timeoutMs',
  'expectedStatusMin',
  'expectedStatusMax',
  'expectedKeyword',
  'followRedirects',
  'maxRedirects',
  'failureThreshold',
  'recoveryThreshold',
] as const;

interface RateLimitEntry {
  windowStartedAt: number;
  count: number;
  inFlight: boolean;
}

class LocalCheckRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.windowStartedAt >= MANUAL_CHECK_WINDOW_MS) {
      entry = { windowStartedAt: now, count: 0, inFlight: false };
      this.entries.set(key, entry);
    }
    if (entry.inFlight || entry.count >= MANUAL_CHECKS_PER_WINDOW) {
      throw new HttpException(
        '같은 대상의 수동 검사는 잠시 후 다시 시도해 주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.count += 1;
    entry.inFlight = true;
    try {
      return await operation();
    } finally {
      entry.inFlight = false;
      if (this.entries.size > 1_000) {
        for (const [candidateKey, candidate] of this.entries) {
          if (!candidate.inFlight && now - candidate.windowStartedAt >= MANUAL_CHECK_WINDOW_MS) {
            this.entries.delete(candidateKey);
          }
        }
      }
    }
  }
}

const checkRateLimiter = new LocalCheckRateLimiter();
let distributedChecker: ReturnType<typeof createHttpChecker> | undefined;

function getDistributedChecker(): ReturnType<typeof createHttpChecker> {
  if (distributedChecker) return distributedChecker;
  const config = getConfig();
  distributedChecker = createHttpChecker({
    destinationLimiter: new RedisDestinationLimiter({
      client: {
        eval: async (script, numberOfKeys, ...args) =>
          getRedis().eval(script, numberOfKeys, ...args),
      },
      maxConcurrent: config.destinationCheckMaxConcurrency,
      maxPerMinute: config.destinationCheckMaxPerMinute,
      leaseMs: config.destinationCheckLeaseMs,
      commandTimeoutMs: config.destinationLimitRedisTimeoutMs,
    }),
  });
  return distributedChecker;
}

async function lockMonitor(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<MonitorRecord | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM monitors
    WHERE id = ${id} AND deleted_at IS NULL
    FOR UPDATE
  `);
  if (locked.length === 0) return null;
  return tx.monitor.findFirst({
    where: { id, deletedAt: null },
    include: monitorInclude,
  });
}

@Injectable()
export class MonitorsService {
  async list(cursor: string | undefined, limit: number, state?: MonitorListState, query?: string) {
    if (state === 'STALE') {
      const now = new Date();
      const candidates = await prisma.monitor.findMany({
        where: buildMonitorListWhere(state, query, now),
        select: { id: true, intervalSec: true, nextCheckAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const staleIds = candidates
        .filter((monitor) =>
          isMonitorStale({
            nextCheckAt: monitor.nextCheckAt,
            intervalSec: monitor.intervalSec,
            now,
          }),
        )
        .map((monitor) => monitor.id);
      const cursorIndex = cursor ? staleIds.indexOf(cursor) : -1;
      if (cursor && cursorIndex < 0) return { items: [], nextCursor: null };
      const pageIds = staleIds.slice(cursorIndex + 1, cursorIndex + 1 + limit + 1);
      const hasMore = pageIds.length > limit;
      const itemIds = hasMore ? pageIds.slice(0, limit) : pageIds;
      const records = await prisma.monitor.findMany({
        where: { id: { in: itemIds } },
        include: monitorInclude,
      });
      const recordsById = new Map(records.map((record) => [record.id, record]));
      const items = itemIds.flatMap((id) => {
        const record = recordsById.get(id);
        return record ? [record] : [];
      });
      return {
        items: items.map(toMonitorView),
        nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    }

    const records = await prisma.monitor.findMany({
      where: buildMonitorListWhere(state, query),
      include: monitorInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = records.length > limit;
    const items = hasMore ? records.slice(0, limit) : records;
    return {
      items: items.map(toMonitorView),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async get(id: string) {
    const monitor = await prisma.monitor.findFirst({
      where: { id, deletedAt: null },
      include: monitorInclude,
    });
    if (!monitor) throw new NotFoundException('모니터를 찾을 수 없습니다.');
    return toMonitorView(monitor);
  }

  async create(input: MonitorInput) {
    const parsedUrl = await validateTarget(input.url);
    const target = storedTarget(parsedUrl);
    const now = new Date();
    const id = randomUUID();
    const monitor = await prisma.$transaction(async (tx) => {
      await assertChannelIds(tx, input.channelIds);
      const created = await tx.monitor.create({
        data: {
          id,
          name: input.name,
          requestUrlEncrypted: encryptedBytes(target.requestUrl),
          displayUrl: target.displayUrl,
          hostnameNormalized: target.hostnameNormalized,
          method: input.method,
          intervalSec: input.intervalSec,
          timeoutMs: input.timeoutMs,
          expectedStatusMin: input.expectedStatusMin,
          expectedStatusMax: input.expectedStatusMax,
          expectedKeyword: input.expectedKeyword || null,
          followRedirects: input.followRedirects,
          maxRedirects: input.maxRedirects,
          failureThreshold: input.failureThreshold,
          recoveryThreshold: input.recoveryThreshold,
          nextCheckAt: calculateInitialNextCheckAt({
            monitorId: id,
            intervalSec: input.intervalSec,
            now,
          }),
          channels: {
            create: Array.from(new Set(input.channelIds)).map((channelId) => ({ channelId })),
          },
        },
        include: monitorInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'MONITOR_CREATED',
          targetType: 'Monitor',
          targetId: created.id,
        },
      });
      return created;
    });
    return toMonitorView(monitor);
  }

  async update(id: string, patch: MonitorPatch) {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockMonitor(tx, id);
      if (!current) throw new NotFoundException('모니터를 찾을 수 없습니다.');

      const currentUrl = decryptedUrl(current.requestUrlEncrypted);
      const requestedUrl = patch.url && patch.url !== current.displayUrl ? patch.url : currentUrl;
      const merged = parseInput(monitorInputSchema, {
        name: patch.name ?? current.name,
        url: requestedUrl,
        method: patch.method ?? current.method,
        intervalSec: patch.intervalSec ?? current.intervalSec,
        timeoutMs: patch.timeoutMs ?? current.timeoutMs,
        expectedStatusMin: patch.expectedStatusMin ?? current.expectedStatusMin,
        expectedStatusMax: patch.expectedStatusMax ?? current.expectedStatusMax,
        expectedKeyword: patch.expectedKeyword ?? current.expectedKeyword ?? '',
        followRedirects: patch.followRedirects ?? current.followRedirects,
        maxRedirects: patch.maxRedirects ?? current.maxRedirects,
        failureThreshold: patch.failureThreshold ?? current.failureThreshold,
        recoveryThreshold: patch.recoveryThreshold ?? current.recoveryThreshold,
        channelIds: patch.channelIds ?? current.channels.map(({ channelId }) => channelId),
      });
      const parsedUrl = await validateTarget(merged.url);
      const target = storedTarget(parsedUrl);
      await assertChannelIds(tx, merged.channelIds);

      const comparable = {
        ...merged,
        url: target.requestUrl,
        expectedKeyword: merged.expectedKeyword || '',
      };
      const previousComparable = {
        name: current.name,
        url: currentUrl,
        method: current.method,
        intervalSec: current.intervalSec,
        timeoutMs: current.timeoutMs,
        expectedStatusMin: current.expectedStatusMin,
        expectedStatusMax: current.expectedStatusMax,
        expectedKeyword: current.expectedKeyword ?? '',
        followRedirects: current.followRedirects,
        maxRedirects: current.maxRedirects,
        failureThreshold: current.failureThreshold,
        recoveryThreshold: current.recoveryThreshold,
        channelIds: current.channels.map(({ channelId }) => channelId),
      };
      const monitoringChanged = configFields.some(
        (field) => comparable[field] !== previousComparable[field],
      );
      const now = new Date();

      if (monitoringChanged) {
        await this.cancelRuntime(tx, id, IncidentClosureReason.CONFIG_CHANGED, now);
      }
      await tx.monitorChannel.deleteMany({ where: { monitorId: id } });
      if (merged.channelIds.length > 0) {
        await tx.monitorChannel.createMany({
          data: Array.from(new Set(merged.channelIds)).map((channelId) => ({
            monitorId: id,
            channelId,
          })),
        });
      }
      const record = await tx.monitor.update({
        where: { id },
        data: {
          name: merged.name,
          requestUrlEncrypted: encryptedBytes(target.requestUrl),
          displayUrl: target.displayUrl,
          hostnameNormalized: target.hostnameNormalized,
          method: merged.method,
          intervalSec: merged.intervalSec,
          timeoutMs: merged.timeoutMs,
          expectedStatusMin: merged.expectedStatusMin,
          expectedStatusMax: merged.expectedStatusMax,
          expectedKeyword: merged.expectedKeyword || null,
          followRedirects: merged.followRedirects,
          maxRedirects: merged.maxRedirects,
          failureThreshold: merged.failureThreshold,
          recoveryThreshold: merged.recoveryThreshold,
          ...(monitoringChanged
            ? {
                configVersion: { increment: 1 },
                healthState: MonitorHealth.PENDING,
                consecutiveFailures: 0,
                consecutiveSuccesses: 0,
                failureStreakStartedAt: null,
                failureStreakFirstErrorType: null,
                nextCheckAt:
                  current.lifecycleStatus === MonitorLifecycle.ACTIVE
                    ? calculateInitialNextCheckAt({
                        monitorId: id,
                        intervalSec: merged.intervalSec,
                        now,
                      })
                    : null,
              }
            : {}),
        },
        include: monitorInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: monitoringChanged ? 'MONITOR_CONFIG_UPDATED' : 'MONITOR_UPDATED',
          targetType: 'Monitor',
          targetId: id,
        },
      });
      return record;
    });
    return toMonitorView(updated);
  }

  async pause(id: string) {
    return this.setLifecycle(id, MonitorLifecycle.PAUSED, IncidentClosureReason.PAUSED);
  }

  async resume(id: string) {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockMonitor(tx, id);
      if (!current) throw new NotFoundException('모니터를 찾을 수 없습니다.');
      if (current.lifecycleStatus === MonitorLifecycle.ACTIVE) return current;
      const now = new Date();
      const record = await tx.monitor.update({
        where: { id },
        data: {
          lifecycleStatus: MonitorLifecycle.ACTIVE,
          healthState: MonitorHealth.PENDING,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          failureStreakStartedAt: null,
          failureStreakFirstErrorType: null,
          nextCheckAt: calculateInitialNextCheckAt({
            monitorId: id,
            intervalSec: current.intervalSec,
            now,
          }),
        },
        include: monitorInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'MONITOR_RESUMED',
          targetType: 'Monitor',
          targetId: id,
        },
      });
      return record;
    });
    return toMonitorView(updated);
  }

  async remove(id: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const current = await lockMonitor(tx, id);
      if (!current) throw new NotFoundException('모니터를 찾을 수 없습니다.');
      const now = new Date();
      await this.cancelRuntime(tx, id, IncidentClosureReason.DELETED, now);
      await tx.monitor.update({
        where: { id },
        data: {
          lifecycleStatus: MonitorLifecycle.DELETED,
          healthState: MonitorHealth.PENDING,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          failureStreakStartedAt: null,
          failureStreakFirstErrorType: null,
          nextCheckAt: null,
          requestUrlEncrypted: secretTombstoneBytes(),
          deletedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'MONITOR_DELETED',
          targetType: 'Monitor',
          targetId: id,
        },
      });
    });
  }

  async checkNow(id: string) {
    const monitor = await prisma.monitor.findFirst({ where: { id, deletedAt: null } });
    if (!monitor) throw new NotFoundException('모니터를 찾을 수 없습니다.');
    return checkRateLimiter.run(`target:${monitor.hostnameNormalized}`, async () => {
      const result = await getDistributedChecker()(
        checkConfig({ ...monitor, url: decryptedUrl(monitor.requestUrlEncrypted) }, 'MANUAL'),
      );
      const stored = await prisma.$transaction(async (tx) => {
        const created = await tx.checkResult.create({
          data: {
            monitorId: id,
            source: result.source,
            outcome: result.outcome,
            configVersion: monitor.configVersion,
            displayUrlSnapshot: monitor.displayUrl,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            statusCode: result.statusCode,
            ttfbMs: result.ttfbMs,
            totalMs: result.totalMs,
            errorType: result.errorType,
            errorMessageSafe: result.errorMessageSafe,
            redirectCount: result.redirectCount,
            responseBytesRead: result.inspectedBodyBytes,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: getConfig().adminUsername,
            action: 'MONITOR_MANUAL_CHECKED',
            targetType: 'Monitor',
            targetId: id,
            metadataSafe: { outcome: result.outcome },
          },
        });
        return created;
      });
      return toCheckResultView(stored);
    });
  }

  async test(input: MonitorInput) {
    const rateTarget = storedTarget(parseTarget(input.url));
    return checkRateLimiter.run(`target:${rateTarget.hostnameNormalized}`, async () => {
      const parsedUrl = await validateTarget(input.url);
      const target = storedTarget(parsedUrl);
      const result = await getDistributedChecker()(
        checkConfig({ ...input, url: target.requestUrl }, 'TEST'),
      );
      const stored = await prisma.$transaction(async (tx) => {
        const created = await tx.checkResult.create({
          data: {
            monitorId: null,
            scheduledCheckId: null,
            source: result.source,
            outcome: result.outcome,
            configVersion: null,
            displayUrlSnapshot: target.displayUrl,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            statusCode: result.statusCode,
            ttfbMs: result.ttfbMs,
            totalMs: result.totalMs,
            errorType: result.errorType,
            errorMessageSafe: result.errorMessageSafe,
            redirectCount: result.redirectCount,
            responseBytesRead: result.inspectedBodyBytes,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: getConfig().adminUsername,
            action: 'MONITOR_TEST_EXECUTED',
            targetType: 'CheckResult',
            targetId: created.id,
            metadataSafe: {
              hostname: target.hostnameNormalized,
              outcome: result.outcome,
            },
          },
        });
        return created;
      });
      return toCheckResultView(stored);
    });
  }

  async checks(id: string, cursor: string | undefined, limit: number) {
    await this.assertExists(id);
    const records = await prisma.checkResult.findMany({
      where: { monitorId: id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = records.length > limit;
    const items = hasMore ? records.slice(0, limit) : records;
    return {
      items: items.map(toCheckResultView),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async incidents(id: string, cursor: string | undefined, limit: number) {
    await this.assertExists(id);
    const records = await prisma.incident.findMany({
      where: { monitorId: id },
      include: {
        outboxEvents: {
          select: {
            id: true,
            channelDisplayNameSnapshot: true,
            eventType: true,
            status: true,
            attemptCount: true,
            lastErrorSafe: true,
            sentAt: true,
            deliveries: {
              where: {
                status: {
                  in: [NotificationDeliveryStatus.FAILED, NotificationDeliveryStatus.UNKNOWN],
                },
              },
              select: {
                id: true,
                attempt: true,
                status: true,
                errorSafe: true,
                startedAt: true,
                finishedAt: true,
              },
              orderBy: { attempt: 'asc' as const },
            },
          },
          orderBy: [{ channelId: 'asc' }, { sequence: 'asc' }],
        },
      },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = records.length > limit;
    const items = hasMore ? records.slice(0, limit) : records;
    return {
      items: items.map(({ outboxEvents, ...incident }) => ({
        ...incident,
        durationMs:
          (incident.resolvedAt?.getTime() ?? incident.canceledAt?.getTime() ?? Date.now()) -
          incident.firstFailureAt.getTime(),
        notifications: outboxEvents,
      })),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  private async assertExists(id: string): Promise<void> {
    const count = await prisma.monitor.count({ where: { id, deletedAt: null } });
    if (count === 0) throw new NotFoundException('모니터를 찾을 수 없습니다.');
  }

  private async setLifecycle(
    id: string,
    lifecycleStatus: MonitorLifecycle,
    reason: IncidentClosureReason,
  ) {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockMonitor(tx, id);
      if (!current) throw new NotFoundException('모니터를 찾을 수 없습니다.');
      if (current.lifecycleStatus === lifecycleStatus) return current;
      const now = new Date();
      await this.cancelRuntime(tx, id, reason, now);
      const record = await tx.monitor.update({
        where: { id },
        data: {
          lifecycleStatus,
          healthState: MonitorHealth.PENDING,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          failureStreakStartedAt: null,
          failureStreakFirstErrorType: null,
          nextCheckAt: null,
        },
        include: monitorInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: getConfig().adminUsername,
          action: 'MONITOR_PAUSED',
          targetType: 'Monitor',
          targetId: id,
        },
      });
      return record;
    });
    return toMonitorView(updated);
  }

  private async cancelRuntime(
    tx: Prisma.TransactionClient,
    monitorId: string,
    reason: IncidentClosureReason,
    now: Date,
  ): Promise<void> {
    await tx.notificationDelivery.updateMany({
      where: {
        status: NotificationDeliveryStatus.ATTEMPTING,
        outbox: { monitorId, status: NotificationOutboxStatus.PROCESSING },
      },
      data: {
        status: NotificationDeliveryStatus.UNKNOWN,
        errorSafe: '모니터 변경으로 발송 추적이 종료되어 전달 여부를 확인할 수 없습니다.',
        finishedAt: now,
      },
    });
    await tx.incident.updateMany({
      where: { monitorId, status: IncidentStatus.OPEN },
      data: { status: IncidentStatus.CANCELED, canceledAt: now, closureReason: reason },
    });
    await tx.scheduledCheck.updateMany({
      where: { monitorId, status: { in: CANCELABLE_CHECK_STATUSES } },
      data: {
        status: ScheduledCheckStatus.CANCELED,
        canceledAt: now,
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    await tx.notificationOutbox.updateMany({
      where: { monitorId, status: { in: CANCELABLE_NOTIFICATION_STATUSES } },
      data: {
        status: NotificationOutboxStatus.CANCELED,
        canceledAt: now,
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    // The incident was closed above, so no terminal DOWN event can create a
    // legitimate recovery after this point. This also deliberately overrides
    // the late-DOWN recovery exception when a monitor is paused/deleted or its
    // configuration changes.
    await tx.notificationOutbox.updateMany({
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
      data: { encryptedConfigSnapshot: secretTombstoneBytes() },
    });
  }
}
