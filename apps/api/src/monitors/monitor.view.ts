import type { Prisma } from '@linkalive/database';

export const monitorInclude = {
  channels: { select: { channelId: true } },
} satisfies Prisma.MonitorInclude;

export type MonitorRecord = Prisma.MonitorGetPayload<{ include: typeof monitorInclude }>;

export function toMonitorView(monitor: MonitorRecord) {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.displayUrl,
    displayUrl: monitor.displayUrl,
    method: monitor.method,
    intervalSec: monitor.intervalSec,
    timeoutMs: monitor.timeoutMs,
    expectedStatusMin: monitor.expectedStatusMin,
    expectedStatusMax: monitor.expectedStatusMax,
    expectedKeyword: monitor.expectedKeyword,
    followRedirects: monitor.followRedirects,
    maxRedirects: monitor.maxRedirects,
    failureThreshold: monitor.failureThreshold,
    recoveryThreshold: monitor.recoveryThreshold,
    lifecycleStatus: monitor.lifecycleStatus,
    healthState: monitor.healthState,
    failureCount: monitor.consecutiveFailures,
    successCount: monitor.consecutiveSuccesses,
    nextCheckAt: monitor.nextCheckAt,
    lastCheckedAt: monitor.lastCheckedAt,
    lastStatusCode: monitor.lastStatusCode,
    lastTtfbMs: monitor.lastTtfbMs,
    lastTotalMs: monitor.lastTotalMs,
    lastErrorType: monitor.lastErrorType,
    lastErrorMessage: null,
    configVersion: monitor.configVersion,
    channelIds: monitor.channels.map(({ channelId }) => channelId),
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
  };
}

export function toCheckResultView(result: {
  id?: string;
  monitorId?: string | null;
  configVersion?: number | null;
  displayUrlSnapshot: string;
  source: string;
  outcome: string;
  startedAt: Date;
  finishedAt: Date;
  statusCode: number | null;
  ttfMs?: number | null;
  ttfbMs?: number | null;
  totalMs: number;
  errorType: string | null;
  errorMessageSafe: string | null;
}) {
  return {
    id: result.id ?? crypto.randomUUID(),
    monitorId: result.monitorId ?? null,
    configVersion: result.configVersion ?? null,
    displayUrlSnapshot: result.displayUrlSnapshot,
    source: result.source,
    outcome: result.outcome,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    statusCode: result.statusCode,
    ttfbMs: result.ttfbMs ?? result.ttfMs ?? null,
    totalMs: result.totalMs,
    errorType: result.errorType,
    errorMessageSafe: result.errorMessageSafe,
  };
}
