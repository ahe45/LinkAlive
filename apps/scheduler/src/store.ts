import { Prisma, prisma, type PrismaClient } from '@linkalive/database';
import {
  calculateNextCheckAt,
  coalesceDueScheduledAt,
  MonitorLifecycle,
  ScheduledCheckStatus,
} from '@linkalive/domain';

export interface ScheduledCheckSummary {
  id: string;
  configVersion: number;
}

export interface DispatchCandidate extends ScheduledCheckSummary {
  status: string;
}

export interface SchedulerStore {
  createDueChecks(now: Date, limit: number): Promise<readonly ScheduledCheckSummary[]>;
  findDispatchCandidates(now: Date, limit: number): Promise<readonly DispatchCandidate[]>;
  claimForDispatch(id: string, owner: string, now: Date, leaseUntil: Date): Promise<boolean>;
  markEnqueued(id: string, owner: string, now: Date, leaseUntil: Date): Promise<void>;
  releaseDispatchClaim(id: string, owner: string, safeReason: string): Promise<void>;
}

interface DueMonitorRow {
  id: string;
  next_check_at: Date;
  interval_sec: number;
  config_version: number;
}

export class PrismaSchedulerStore implements SchedulerStore {
  constructor(private readonly client: PrismaClient = prisma) {}

  async createDueChecks(now: Date, limit: number): Promise<readonly ScheduledCheckSummary[]> {
    return this.client.$transaction(
      async (tx) => {
        const due = await tx.$queryRaw<DueMonitorRow[]>(Prisma.sql`
        SELECT id, next_check_at, interval_sec, config_version
        FROM monitors
        WHERE lifecycle_status = 'ACTIVE'
          AND deleted_at IS NULL
          AND next_check_at IS NOT NULL
          AND next_check_at <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM scheduled_checks sc
            WHERE sc.monitor_id = monitors.id
              AND sc.status IN (
                'PENDING',
                'ENQUEUED',
                'RUNNING'
              )
          )
        ORDER BY next_check_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
        const created: ScheduledCheckSummary[] = [];

        for (const monitor of due) {
          const scheduledAt = coalesceDueScheduledAt({
            nextCheckAt: monitor.next_check_at,
            intervalSec: monitor.interval_sec,
            now,
          });
          if (!scheduledAt) continue;
          const nextCheckAt = calculateNextCheckAt({
            scheduledAt,
            intervalSec: monitor.interval_sec,
            now,
          });
          const check = await tx.scheduledCheck.create({
            data: {
              monitorId: monitor.id,
              scheduledAt,
              configVersion: monitor.config_version,
              status: ScheduledCheckStatus.PENDING,
            },
            select: { id: true, configVersion: true },
          });
          await tx.monitor.update({
            where: { id: monitor.id },
            data: { nextCheckAt },
          });
          created.push(check);
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async findDispatchCandidates(now: Date, limit: number): Promise<readonly DispatchCandidate[]> {
    return this.client.scheduledCheck.findMany({
      where: {
        OR: [
          {
            status: ScheduledCheckStatus.PENDING,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
          {
            status: { in: [ScheduledCheckStatus.ENQUEUED, ScheduledCheckStatus.RUNNING] },
            leaseUntil: { lt: now },
            result: null,
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, configVersion: true, status: true },
    });
  }

  async claimForDispatch(id: string, owner: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const result = await this.client.scheduledCheck.updateMany({
      where: {
        id,
        completedAt: null,
        OR: [
          {
            status: ScheduledCheckStatus.PENDING,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
          {
            status: { in: [ScheduledCheckStatus.ENQUEUED, ScheduledCheckStatus.RUNNING] },
            leaseUntil: { lt: now },
          },
        ],
      },
      data: {
        status: ScheduledCheckStatus.PENDING,
        leaseOwner: owner,
        leaseUntil,
        attemptCount: { increment: 1 },
        failureReasonSafe: null,
      },
    });
    return result.count === 1;
  }

  async markEnqueued(id: string, owner: string, now: Date, leaseUntil: Date): Promise<void> {
    await this.client.scheduledCheck.updateMany({
      where: {
        id,
        leaseOwner: owner,
        status: ScheduledCheckStatus.PENDING,
        completedAt: null,
      },
      data: {
        status: ScheduledCheckStatus.ENQUEUED,
        queueJobId: id,
        enqueuedAt: now,
        leaseUntil,
      },
    });
  }

  async releaseDispatchClaim(id: string, owner: string, safeReason: string): Promise<void> {
    await this.client.scheduledCheck.updateMany({
      where: {
        id,
        leaseOwner: owner,
        status: ScheduledCheckStatus.PENDING,
        completedAt: null,
      },
      data: {
        status: ScheduledCheckStatus.PENDING,
        leaseOwner: null,
        leaseUntil: null,
        failureReasonSafe: safeReason.slice(0, 1_000),
      },
    });
  }
}
