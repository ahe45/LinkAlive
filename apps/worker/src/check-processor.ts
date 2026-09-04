import {
  CheckErrorType,
  CheckOutcome,
  CheckSource,
  IncidentClosureReason,
  IncidentStatus,
  MonitorLifecycle,
  NotificationEventType,
  NotificationOutboxStatus,
  Prisma,
  ScheduledCheckStatus,
  prisma,
  type PrismaClient,
} from '@linkalive/database';
import {
  applyCheckResult,
  createNotificationDedupeKey,
  notificationSequence,
  planRecoveryNotification,
  type IncidentEffect,
  type StateTransitionResult,
} from '@linkalive/domain';
import { checkUrl, type MonitorCheckConfig, type MonitorCheckResult } from '@linkalive/monitoring';
import { createStableMessageId } from '@linkalive/notifications';

import { decryptString } from './crypto.js';
import { makeNotificationPayload, payloadAllowsRecovery } from './notification-payload.js';
import {
  retiredNotificationSecretData,
  shouldRetainNotificationSecret,
} from './secret-lifecycle.js';

export interface CheckJobData {
  scheduledCheckId: string;
  configVersion: number;
}

export interface CheckProcessorConfig {
  instanceId: string;
  region: string;
  leaseMs: number;
  encryptionKey: Buffer;
  appBaseUrl: string | null;
  messageIdDomain?: string;
}

export type CheckRunner = (config: MonitorCheckConfig) => Promise<MonitorCheckResult>;

type Tx = Prisma.TransactionClient;
type CheckWithMonitor = Prisma.ScheduledCheckGetPayload<{
  include: { monitor: true; result: true };
}>;
type LockedMonitor = Prisma.MonitorGetPayload<Record<string, never>>;

function platformFailure(configVersion: number, startedAt: Date): MonitorCheckResult {
  const finishedAt = new Date();
  return {
    source: 'SCHEDULED',
    outcome: 'PLATFORM_ERROR',
    configVersion,
    startedAt,
    finishedAt,
    statusCode: null,
    ttfbMs: null,
    totalMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    errorType: 'PLATFORM_ERROR',
    errorMessageSafe: '검사 설정을 안전하게 읽지 못했습니다.',
    finalUrlDisplay: '(URL 숨김)',
    redirectCount: 0,
    inspectedBodyBytes: 0,
  };
}

async function createOutbox(
  tx: Tx,
  options: {
    monitor: LockedMonitor;
    incident: Prisma.IncidentGetPayload<Record<string, never>>;
    result: MonitorCheckResult;
    appBaseUrl: string | null;
    messageIdDomain?: string;
  },
): Promise<void> {
  const bindings = await tx.monitorChannel.findMany({
    where: {
      monitorId: options.monitor.id,
      notifyOnDown: true,
      channel: { type: 'TELEGRAM', enabled: true, deletedAt: null },
    },
    include: { channel: true },
  });
  for (const binding of bindings) {
    const eventType = NotificationEventType.DOWN;
    const dedupeKey = createNotificationDedupeKey({
      incidentId: options.incident.id,
      channelId: binding.channelId,
      eventType,
    });
    await tx.notificationOutbox.create({
      data: {
        monitorId: options.monitor.id,
        incidentId: options.incident.id,
        channelId: binding.channelId,
        eventType,
        sequence: notificationSequence(eventType),
        dedupeKey,
        payloadSafe: makeNotificationPayload({
          eventType,
          monitor: options.monitor,
          incident: options.incident,
          result: options.result,
          appBaseUrl: options.appBaseUrl,
          notifyOnRecovery: binding.notifyOnRecovery,
        }),
        channelTypeSnapshot: binding.channel.type,
        channelDisplayNameSnapshot: binding.channel.displayName,
        encryptedConfigSnapshot: binding.channel.encryptedConfig,
        status: NotificationOutboxStatus.PENDING,
        messageId: createStableMessageId(dedupeKey, options.messageIdDomain),
      },
    });
  }
}

async function createRecoveryOutbox(
  tx: Tx,
  options: {
    monitor: LockedMonitor;
    incident: Prisma.IncidentGetPayload<Record<string, never>>;
    result: MonitorCheckResult;
    appBaseUrl: string | null;
    messageIdDomain?: string;
  },
): Promise<void> {
  const downEvents = await tx.notificationOutbox.findMany({
    where: {
      incidentId: options.incident.id,
      eventType: NotificationEventType.DOWN,
      channel: {
        type: 'TELEGRAM',
        enabled: true,
        deletedAt: null,
        monitors: {
          some: {
            monitorId: options.monitor.id,
            notifyOnRecovery: true,
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const down of downEvents) {
    const allowsRecovery = payloadAllowsRecovery(down.payloadSafe);
    let currentDownStatus = down.status;
    let currentDownLastError = down.lastErrorSafe;
    if (!allowsRecovery) {
      if (
        !shouldRetainNotificationSecret({
          status: currentDownStatus,
          eventType: down.eventType,
          lastErrorSafe: currentDownLastError,
          payloadAllowsRecovery: false,
          incidentStatus: options.incident.status,
        })
      ) {
        await tx.notificationOutbox.update({
          where: { id: down.id },
          data: retiredNotificationSecretData(),
        });
      }
      continue;
    }
    let plan = planRecoveryNotification({
      downStatus: currentDownStatus,
      downAttemptCount: down.attemptCount,
    });

    if (plan.action === 'REPLACE_WITH_RESOLVED_SUMMARY') {
      const canceled = await tx.notificationOutbox.updateMany({
        where: {
          id: down.id,
          attemptCount: 0,
          status: { in: [NotificationOutboxStatus.PENDING, NotificationOutboxStatus.ENQUEUED] },
        },
        data: {
          status: NotificationOutboxStatus.CANCELED,
          canceledAt: options.incident.resolvedAt,
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      if (canceled.count === 1) currentDownStatus = NotificationOutboxStatus.CANCELED;
      if (canceled.count === 0) {
        const current = await tx.notificationOutbox.findUniqueOrThrow({ where: { id: down.id } });
        currentDownStatus = current.status;
        currentDownLastError = current.lastErrorSafe;
        plan = planRecoveryNotification({
          downStatus: current.status,
          downAttemptCount: current.attemptCount,
        });
      }
    }

    if (plan.action === 'SKIP') {
      if (
        !shouldRetainNotificationSecret({
          status: currentDownStatus,
          eventType: down.eventType,
          lastErrorSafe: currentDownLastError,
          payloadAllowsRecovery: allowsRecovery,
          incidentStatus: options.incident.status,
        })
      ) {
        await tx.notificationOutbox.update({
          where: { id: down.id },
          data: retiredNotificationSecretData(),
        });
      }
      continue;
    }
    const eventType =
      plan.action === 'REPLACE_WITH_RESOLVED_SUMMARY'
        ? NotificationEventType.RESOLVED_SUMMARY
        : NotificationEventType.RECOVERY;
    const dedupeKey = createNotificationDedupeKey({
      incidentId: options.incident.id,
      channelId: down.channelId,
      eventType,
    });
    await tx.notificationOutbox.create({
      data: {
        monitorId: options.monitor.id,
        incidentId: options.incident.id,
        channelId: down.channelId,
        eventType,
        sequence: notificationSequence(eventType),
        dedupeKey,
        payloadSafe: makeNotificationPayload({
          eventType,
          monitor: options.monitor,
          incident: options.incident,
          result: options.result,
          appBaseUrl: options.appBaseUrl,
          notifyOnRecovery: true,
        }),
        channelTypeSnapshot: down.channelTypeSnapshot,
        channelDisplayNameSnapshot: down.channelDisplayNameSnapshot,
        encryptedConfigSnapshot: down.encryptedConfigSnapshot,
        status: NotificationOutboxStatus.PENDING,
        messageId: createStableMessageId(dedupeKey, options.messageIdDomain),
      },
    });
    if (
      !shouldRetainNotificationSecret({
        status: currentDownStatus,
        eventType: down.eventType,
        lastErrorSafe: currentDownLastError,
        payloadAllowsRecovery: allowsRecovery,
        incidentStatus: options.incident.status,
      })
    ) {
      await tx.notificationOutbox.update({
        where: { id: down.id },
        data: retiredNotificationSecretData(),
      });
    }
  }
}

async function applyIncidentEffect(
  tx: Tx,
  monitor: LockedMonitor,
  result: MonitorCheckResult,
  effect: IncidentEffect,
  config: CheckProcessorConfig,
): Promise<void> {
  if (effect.type === 'NONE') return;
  if (effect.type === 'OPEN') {
    const existing = await tx.incident.findFirst({
      where: { monitorId: monitor.id, status: IncidentStatus.OPEN },
      orderBy: { detectedAt: 'desc' },
    });
    const incident =
      existing ??
      (await tx.incident.create({
        data: {
          monitorId: monitor.id,
          configVersion: monitor.configVersion,
          status: IncidentStatus.OPEN,
          firstFailureAt: effect.firstFailureAt,
          detectedAt: effect.detectedAt,
          firstErrorType: effect.firstErrorType,
          lastErrorType: effect.lastErrorType,
        },
      }));
    if (existing) {
      await tx.incident.update({
        where: { id: existing.id },
        data: { lastErrorType: effect.lastErrorType },
      });
      return;
    }
    await createOutbox(tx, {
      monitor,
      incident,
      result,
      appBaseUrl: config.appBaseUrl,
      ...(config.messageIdDomain ? { messageIdDomain: config.messageIdDomain } : {}),
    });
    return;
  }

  const open = await tx.incident.findFirst({
    where: { monitorId: monitor.id, status: IncidentStatus.OPEN },
    orderBy: { detectedAt: 'desc' },
  });
  if (!open) return;
  if (effect.type === 'UPDATE') {
    await tx.incident.update({
      where: { id: open.id },
      data: { lastErrorType: effect.lastErrorType },
    });
    return;
  }
  if (effect.type === 'RESOLVE') {
    const incident = await tx.incident.update({
      where: { id: open.id },
      data: {
        status: IncidentStatus.RESOLVED,
        resolvedAt: effect.resolvedAt,
        closureReason: IncidentClosureReason.RECOVERED,
      },
    });
    await createRecoveryOutbox(tx, {
      monitor,
      incident,
      result,
      appBaseUrl: config.appBaseUrl,
      ...(config.messageIdDomain ? { messageIdDomain: config.messageIdDomain } : {}),
    });
  }
}

function monitorUpdate(
  monitor: LockedMonitor,
  result: MonitorCheckResult,
  transition: StateTransitionResult,
): Prisma.MonitorUpdateInput {
  const success = result.outcome === CheckOutcome.SUCCESS;
  return {
    healthState: transition.state.healthState,
    consecutiveFailures: transition.state.consecutiveFailures,
    consecutiveSuccesses: transition.state.consecutiveSuccesses,
    failureStreakStartedAt: transition.state.failureStreakStartedAt,
    failureStreakFirstErrorType: transition.state.failureStreakFirstErrorType,
    lastCheckedAt: result.finishedAt,
    lastStatusCode: result.statusCode,
    lastTtfbMs: result.ttfbMs,
    lastTotalMs: result.totalMs,
    lastErrorType: result.errorType,
    ...(success ? { lastSuccessAt: result.finishedAt } : { lastFailureAt: result.finishedAt }),
  };
}

export class ScheduledCheckProcessor {
  constructor(
    private readonly config: CheckProcessorConfig,
    private readonly client: PrismaClient = prisma,
    private readonly runCheck: CheckRunner = checkUrl,
  ) {}

  async process(data: CheckJobData): Promise<{ status: 'completed' | 'duplicate' | 'canceled' }> {
    const scheduled = await this.client.scheduledCheck.findUnique({
      where: { id: data.scheduledCheckId },
      include: { monitor: true, result: true },
    });
    if (!scheduled) return { status: 'canceled' };
    if (scheduled.result || scheduled.status === ScheduledCheckStatus.COMPLETED)
      return { status: 'duplicate' };
    // The DB ledger is authoritative. A stale/corrupt queue payload must not
    // cancel an otherwise valid scheduled check.
    if (scheduled.configVersion !== data.configVersion) return { status: 'duplicate' };
    if (
      scheduled.monitor.configVersion !== data.configVersion ||
      scheduled.monitor.lifecycleStatus !== MonitorLifecycle.ACTIVE ||
      scheduled.monitor.deletedAt
    ) {
      await this.cancelStale(scheduled.id);
      return { status: 'canceled' };
    }

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.config.leaseMs);
    const claim = await this.client.scheduledCheck.updateMany({
      where: {
        id: scheduled.id,
        completedAt: null,
        OR: [
          { status: { in: [ScheduledCheckStatus.PENDING, ScheduledCheckStatus.ENQUEUED] } },
          { status: ScheduledCheckStatus.RUNNING, leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: ScheduledCheckStatus.RUNNING,
        leaseOwner: this.config.instanceId,
        leaseUntil,
        startedAt: now,
      },
    });
    if (claim.count !== 1) return { status: 'duplicate' };

    let result: MonitorCheckResult;
    try {
      const url = decryptString(scheduled.monitor.requestUrlEncrypted, this.config.encryptionKey);
      result = await this.runCheck({
        url,
        method: scheduled.monitor.method,
        timeoutMs: scheduled.monitor.timeoutMs,
        expectedStatusMin: scheduled.monitor.expectedStatusMin,
        expectedStatusMax: scheduled.monitor.expectedStatusMax,
        expectedKeyword: scheduled.monitor.expectedKeyword,
        followRedirects: scheduled.monitor.followRedirects,
        maxRedirects: scheduled.monitor.maxRedirects,
        source: 'SCHEDULED',
        configVersion: scheduled.configVersion,
      });
    } catch {
      result = platformFailure(scheduled.configVersion, now);
    }

    return this.persist(scheduled, result);
  }

  private async cancelStale(id: string): Promise<void> {
    const now = new Date();
    await this.client.scheduledCheck.updateMany({
      where: {
        id,
        status: {
          in: [
            ScheduledCheckStatus.PENDING,
            ScheduledCheckStatus.ENQUEUED,
            ScheduledCheckStatus.RUNNING,
          ],
        },
      },
      data: {
        status: ScheduledCheckStatus.CANCELED,
        canceledAt: now,
        leaseOwner: null,
        leaseUntil: null,
        failureReasonSafe: '설정 변경 또는 모니터 중지로 검사가 취소되었습니다.',
      },
    });
  }

  private async persist(
    original: CheckWithMonitor,
    result: MonitorCheckResult,
  ): Promise<{ status: 'completed' | 'duplicate' | 'canceled' }> {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM monitors WHERE id = ${original.monitorId} FOR UPDATE`,
          );
          const scheduled = await tx.scheduledCheck.findUnique({
            where: { id: original.id },
            include: { result: true },
          });
          if (!scheduled || scheduled.result) return { status: 'duplicate' as const };
          const monitor = await tx.monitor.findUniqueOrThrow({ where: { id: original.monitorId } });
          await tx.checkResult.create({
            data: {
              monitorId: monitor.id,
              scheduledCheckId: scheduled.id,
              source: CheckSource.SCHEDULED,
              outcome: result.outcome,
              configVersion: scheduled.configVersion,
              // The request was made with the configuration captured before
              // the lease was claimed. A concurrent edit may change the live
              // monitor while the network request is in flight.
              displayUrlSnapshot: original.monitor.displayUrl,
              startedAt: result.startedAt,
              finishedAt: result.finishedAt,
              statusCode: result.statusCode,
              ttfbMs: result.ttfbMs,
              totalMs: result.totalMs,
              errorType: result.errorType,
              errorMessageSafe: result.errorMessageSafe?.slice(0, 1_000) ?? null,
              workerRegion: this.config.region,
              redirectCount: result.redirectCount,
              responseBytesRead: result.inspectedBodyBytes,
            },
          });

          const valid =
            [
              ScheduledCheckStatus.PENDING,
              ScheduledCheckStatus.ENQUEUED,
              ScheduledCheckStatus.RUNNING,
            ].some((status) => status === scheduled.status) &&
            scheduled.configVersion === monitor.configVersion &&
            monitor.lifecycleStatus === MonitorLifecycle.ACTIVE &&
            monitor.deletedAt === null;
          if (valid) {
            const transition = applyCheckResult(
              {
                lifecycleStatus: monitor.lifecycleStatus,
                healthState: monitor.healthState,
                consecutiveFailures: monitor.consecutiveFailures,
                consecutiveSuccesses: monitor.consecutiveSuccesses,
                failureStreakStartedAt: monitor.failureStreakStartedAt,
                failureStreakFirstErrorType: monitor.failureStreakFirstErrorType,
                configVersion: monitor.configVersion,
              },
              {
                source: CheckSource.SCHEDULED,
                outcome: result.outcome,
                configVersion: scheduled.configVersion,
                checkedAt: result.finishedAt,
                errorType: result.errorType,
                failureThreshold: monitor.failureThreshold,
                recoveryThreshold: monitor.recoveryThreshold,
              },
            );
            if (transition.applied) {
              await tx.monitor.update({
                where: { id: monitor.id },
                data: monitorUpdate(monitor, result, transition),
              });
              await applyIncidentEffect(
                tx,
                monitor,
                result,
                transition.incidentEffect,
                this.config,
              );
            }
          }

          if (scheduled.status !== ScheduledCheckStatus.CANCELED) {
            await tx.scheduledCheck.update({
              where: { id: scheduled.id },
              data: {
                status: ScheduledCheckStatus.COMPLETED,
                completedAt: result.finishedAt,
                leaseOwner: null,
                leaseUntil: null,
                failureReasonSafe: null,
              },
            });
          }
          return { status: valid ? ('completed' as const) : ('canceled' as const) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      const uniqueTarget =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? JSON.stringify(error.meta?.target ?? '')
          : '';
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        uniqueTarget.includes('scheduled_check')
      ) {
        return { status: 'duplicate' };
      }
      throw error;
    }
  }
}
