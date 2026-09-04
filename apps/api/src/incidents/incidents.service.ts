import { Injectable, NotFoundException } from '@nestjs/common';
import { IncidentStatus, NotificationDeliveryStatus, prisma } from '@linkalive/database';

function view(incident: {
  id: string;
  monitorId: string;
  status: IncidentStatus;
  firstFailureAt: Date;
  detectedAt: Date;
  resolvedAt: Date | null;
  canceledAt: Date | null;
  firstErrorType: string | null;
  lastErrorType: string | null;
  closureReason: string | null;
  monitor: { name: string; displayUrl: string };
}) {
  const endedAt = incident.resolvedAt ?? incident.canceledAt;
  return {
    id: incident.id,
    monitorId: incident.monitorId,
    monitorName: incident.monitor.name,
    displayUrl: incident.monitor.displayUrl,
    status: incident.status,
    firstFailureAt: incident.firstFailureAt,
    detectedAt: incident.detectedAt,
    resolvedAt: incident.resolvedAt,
    canceledAt: incident.canceledAt,
    firstErrorType: incident.firstErrorType,
    lastErrorType: incident.lastErrorType,
    closureReason: incident.closureReason,
    durationMs: (endedAt?.getTime() ?? Date.now()) - incident.firstFailureAt.getTime(),
  };
}

@Injectable()
export class IncidentsService {
  async list(cursor: string | undefined, limit: number, status?: IncidentStatus) {
    const rows = await prisma.incident.findMany({
      ...(status ? { where: { status } } : {}),
      include: { monitor: { select: { name: true, displayUrl: true } } },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items: items.map(view), nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  async get(id: string) {
    const incident = await prisma.incident.findUnique({
      where: { id },
      include: { monitor: { select: { name: true, displayUrl: true } } },
    });
    if (!incident) throw new NotFoundException('장애 이력을 찾을 수 없습니다.');
    const notifications = await prisma.notificationOutbox.findMany({
      where: { incidentId: id },
      select: {
        id: true,
        channelId: true,
        eventType: true,
        sequence: true,
        status: true,
        attemptCount: true,
        lastErrorSafe: true,
        sentAt: true,
        channelDisplayNameSnapshot: true,
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
    });
    return { ...view(incident), notifications };
  }
}
