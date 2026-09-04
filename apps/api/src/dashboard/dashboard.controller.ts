import { Controller, Get } from '@nestjs/common';
import { MonitorHealth, MonitorLifecycle, prisma } from '@linkalive/database';

@Controller('dashboard')
export class DashboardController {
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
