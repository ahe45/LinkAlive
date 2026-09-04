import type { Prisma } from '@linkalive/database';
import type { NotificationEventType as NotificationEventTypeValue } from '@linkalive/domain';
import type { MonitorCheckResult } from '@linkalive/monitoring';
import type { SafeNotificationPayload } from '@linkalive/notifications';

interface PayloadMonitor {
  id: string;
  name: string;
  displayUrl: string;
}

interface PayloadIncident {
  detectedAt: Date;
  resolvedAt: Date | null;
  firstFailureAt: Date;
  firstErrorType: string | null;
  lastErrorType: string | null;
}

export function makeNotificationPayload(options: {
  eventType: Exclude<NotificationEventTypeValue, 'TEST'>;
  monitor: PayloadMonitor;
  incident: PayloadIncident;
  result?: MonitorCheckResult;
  appBaseUrl?: string | null;
  notifyOnRecovery: boolean;
}): Prisma.InputJsonObject {
  const { eventType, monitor, incident, result } = options;
  const occurredAt =
    eventType === 'DOWN'
      ? incident.detectedAt
      : (incident.resolvedAt ?? result?.finishedAt ?? new Date());
  const payload: Record<string, Prisma.InputJsonValue | null> = {
    eventType,
    monitorName: monitor.name.slice(0, 160),
    displayUrl: monitor.displayUrl,
    occurredAt: occurredAt.toISOString(),
    errorType: result?.errorType ?? incident.lastErrorType ?? incident.firstErrorType,
    errorMessageSafe: result?.errorMessageSafe ?? null,
    statusCode: result?.statusCode ?? null,
    ttfbMs: result?.ttfbMs ?? null,
    notifyOnRecovery: options.notifyOnRecovery,
  };
  if (eventType !== 'DOWN' && incident.resolvedAt) {
    payload.durationMs = Math.max(
      0,
      incident.resolvedAt.getTime() - incident.firstFailureAt.getTime(),
    );
  }
  if (options.appBaseUrl)
    payload.dashboardUrl = `${options.appBaseUrl}/monitors/${encodeURIComponent(monitor.id)}`;
  return payload as Prisma.InputJsonObject;
}

export function parseNotificationPayload(
  value: Prisma.JsonValue,
  eventType: SafeNotificationPayload['eventType'],
): SafeNotificationPayload {
  const data =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Prisma.JsonValue>)
      : {};
  const string = (key: string, fallback = ''): string =>
    typeof data[key] === 'string' ? (data[key] as string) : fallback;
  const nullableString = (key: string): string | null =>
    typeof data[key] === 'string' ? (data[key] as string) : null;
  const nullableNumber = (key: string): number | null =>
    typeof data[key] === 'number' && Number.isFinite(data[key]) ? (data[key] as number) : null;

  return {
    eventType,
    monitorName: string('monitorName', '이름 없는 모니터'),
    displayUrl: string('displayUrl', '(URL 숨김)'),
    occurredAt: string('occurredAt', new Date().toISOString()),
    errorType: nullableString('errorType'),
    errorMessageSafe: nullableString('errorMessageSafe'),
    statusCode: nullableNumber('statusCode'),
    ttfbMs: nullableNumber('ttfbMs'),
    durationMs: nullableNumber('durationMs'),
    dashboardUrl: nullableString('dashboardUrl'),
  };
}

export function payloadAllowsRecovery(value: Prisma.JsonValue): boolean {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && value.notifyOnRecovery === true,
  );
}
