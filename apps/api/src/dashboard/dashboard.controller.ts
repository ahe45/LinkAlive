import { Controller, Get } from '@nestjs/common';
import {
  CheckOutcome,
  CheckSource,
  MonitorHealth,
  MonitorLifecycle,
  Prisma,
  prisma,
} from '@linkalive/database';
import { Public } from '../auth/public.decorator.js';
import {
  type AvailabilityAggregateRow,
  publicAvailabilityWindow,
  summarizePublicAvailability,
} from './public-availability.js';

@Controller('dashboard')
export class DashboardController {
  @Public()
  @Get('public-stats')
  async publicStats() {
    const now = new Date();
    const { start, end } = publicAvailabilityWindow(now);
    const rows = await prisma.$queryRaw<AvailabilityAggregateRow[]>(Prisma.sql`
      SELECT
        CAST(FLOOR(TIMESTAMPDIFF(SECOND, ${start}, finished_at) / 86400) AS SIGNED) AS bucketIndex,
        CAST(SUM(outcome = ${CheckOutcome.SUCCESS}) AS UNSIGNED) AS successCount,
        COUNT(*) AS totalCount
      FROM check_results
      WHERE created_at >= ${start}
        AND finished_at >= ${start}
        AND finished_at < ${end}
        AND source = ${CheckSource.SCHEDULED}
        AND outcome IN (${CheckOutcome.SUCCESS}, ${CheckOutcome.TARGET_FAILURE})
      GROUP BY bucketIndex
      ORDER BY bucketIndex ASC
    `);
    return summarizePublicAvailability(rows, now);
  }

  @Get('summary')
  async summary() {
    const active = { lifecycleStatus: MonitorLifecycle.ACTIVE, deletedAt: null } as const;
    const [total, paused, up, suspect, down, pending, recovering, candidates] = await Promise.all([
      prisma.monitor.count({ where: { deletedAt: null } }),
      prisma.monitor.count({
        where: { lifecycleStatus: MonitorLifecycle.PAUSED, deletedAt: null },
      }),
      prisma.monitor.count({ where: { ...active, healthState: MonitorHealth.UP } }),
      prisma.monitor.count({ where: { ...active, healthState: MonitorHealth.SUSPECT } }),
      prisma.monitor.count({ where: { ...active, healthState: MonitorHealth.DOWN } }),
      prisma.monitor.count({ where: { ...active, healthState: MonitorHealth.PENDING } }),
      prisma.monitor.count({ where: { ...active, healthState: MonitorHealth.RECOVERING } }),
      prisma.monitor.findMany({
        where: active,
        select: { nextCheckAt: true, intervalSec: true, healthState: true },
      }),
    ]);
    const now = Date.now();
    const stale = candidates.filter(({ nextCheckAt, intervalSec }) => {
      if (!nextCheckAt) return true;
      return now > nextCheckAt.getTime() + Math.max(intervalSec * 2_000, 5 * 60_000);
    }).length;
    const warningStates = new Set<MonitorHealth>([
      MonitorHealth.SUSPECT,
      MonitorHealth.RECOVERING,
      MonitorHealth.PENDING,
    ]);
    const warning = candidates.filter(({ nextCheckAt, intervalSec, healthState }) => {
      const isStale =
        !nextCheckAt || now > nextCheckAt.getTime() + Math.max(intervalSec * 2_000, 5 * 60_000);
      return warningStates.has(healthState) || isStale;
    }).length;
    return { total, up, suspect, down, paused, pending, recovering, stale, warning };
  }
}
