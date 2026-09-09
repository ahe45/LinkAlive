import { prisma, Prisma, type PrismaClient } from '@linkalive/database';
import {
  checkReferenceUrls,
  checkUrl,
  type MonitorCheckConfig,
  type MonitorCheckResult,
} from '@linkalive/monitoring';
import { createStableMessageId } from '@linkalive/notifications';
import {
  inconclusiveNetworkResult,
  isNetworkFailure,
  referenceStatus,
  referenceCheckIntervalMs,
} from './network-policy.js';

type Runner = (config: MonitorCheckConfig) => Promise<MonitorCheckResult>;
interface Snapshot {
  status: string;
  outageId: string | null;
  checkedAt: Date;
}
export interface NetworkAssessment {
  result: MonitorCheckResult;
  outageId: string | null;
}

export class NetworkGuard {
  private inFlight: Promise<Snapshot> | null = null;
  private cached: Snapshot | null = null;

  constructor(
    private readonly observerId: string,
    private readonly appBaseUrl: string | null,
    private readonly client: PrismaClient = prisma,
    private readonly probe: Runner = checkUrl,
  ) {}

  async assess(
    result: MonitorCheckResult,
    retry: () => Promise<MonitorCheckResult>,
  ): Promise<NetworkAssessment> {
    if (!isNetworkFailure(result)) return { result, outageId: null };
    const snapshot = await this.inspect();
    if (snapshot.status === 'DISABLED') return { result, outageId: null };
    if (snapshot.status === 'ONLINE') {
      // A short interruption can finish between target failure and the references.
      const retried = await retry();
      if (!isNetworkFailure(retried)) return { result: retried, outageId: null };
      const confirmed = await this.inspect(true);
      return confirmed.status === 'ONLINE' || confirmed.status === 'DISABLED'
        ? { result: retried, outageId: null }
        : { result: inconclusiveNetworkResult(retried), outageId: confirmed.outageId };
    }
    return { result: inconclusiveNetworkResult(result), outageId: snapshot.outageId };
  }

  async tick(): Promise<void> {
    await this.inspect(true);
    await this.summarize();
  }

  async poll(): Promise<void> {
    // The local loop also processes summaries. Only send reference requests
    // when due; on-demand target-failure probes update this same snapshot.
    if (
      !this.cached ||
      Date.now() - this.cached.checkedAt.getTime() >=
        referenceCheckIntervalMs(this.cached.status, this.cached.outageId)
    ) {
      await this.inspect(true);
    }
    await this.summarize();
  }

  nextPollDelayMs(): number {
    if (!this.cached) return 10_000;
    const remaining =
      referenceCheckIntervalMs(this.cached.status, this.cached.outageId) -
      (Date.now() - this.cached.checkedAt.getTime());
    return Math.min(10_000, Math.max(1, remaining));
  }

  async inspect(force = false): Promise<Snapshot> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.cached && Date.now() - this.cached.checkedAt.getTime() < 1_000)
      return this.cached;
    this.inFlight = this.inspectFresh();
    try {
      this.cached = await this.inFlight;
      return this.cached;
    } finally {
      this.inFlight = null;
    }
  }

  private async inspectFresh(): Promise<Snapshot> {
    const settings = await this.client.networkSettings.findUnique({ where: { id: 1 } });
    const urls = Array.isArray(settings?.urls)
      ? settings.urls.filter((url): url is string => typeof url === 'string')
      : [];
    const enabled = Boolean(settings?.enabled && urls.length >= 2);
    const startedAt = new Date();
    const results = enabled ? await checkReferenceUrls(urls, this.probe) : [];
    const status = enabled ? referenceStatus(results) : 'DISABLED';
    const checkedAt = new Date();
    return this.client.$transaction(async (tx) => {
      // Serialize workers on the same PC; reject probes from superseded settings.
      const currentSettings = await tx.networkSettings.findUnique({ where: { id: 1 } });
      if ((currentSettings?.version ?? 0) !== (settings?.version ?? 0))
        return { status: 'UNKNOWN', outageId: null, checkedAt };
      await tx.networkObserver.upsert({
        where: { id: this.observerId },
        create: { id: this.observerId },
        update: {},
      });
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM network_observers WHERE id = ${this.observerId} FOR UPDATE`,
      );
      const observer = await tx.networkObserver.findUniqueOrThrow({
        where: { id: this.observerId },
      });
      if (observer.checkedAt && observer.checkedAt > startedAt) {
        return {
          status: observer.status,
          outageId: observer.activeOutageId,
          checkedAt: observer.checkedAt,
        };
      }
      let outageId = observer.activeOutageId;
      if (status === 'OFFLINE' && !outageId) {
        const outage = await tx.networkOutage.create({
          data: { observerId: this.observerId, startedAt, channelIds: settings?.channelIds ?? [] },
        });
        outageId = outage.id;
      }
      if ((status === 'ONLINE' || status === 'DISABLED') && outageId) {
        await tx.networkOutage.update({
          where: { id: outageId },
          data:
            status === 'ONLINE'
              ? { recoveredAt: checkedAt }
              : { canceledAt: checkedAt, summarizedAt: checkedAt },
        });
        // Let the scheduler enqueue immediate checks through its normal ledger.
        await tx.monitor.updateMany({
          where: {
            lifecycleStatus: 'ACTIVE',
            deletedAt: null,
            networkObservations: { some: { outageId, recheckedAt: null } },
          },
          data: { nextCheckAt: checkedAt },
        });
        outageId = null;
      }
      await tx.networkObserver.update({
        where: { id: this.observerId },
        data: {
          status,
          checkedAt,
          activeOutageId: outageId,
          probeResults: results.map((result, i) => ({
            url: urls[i]!,
            reachable: result.statusCode !== null,
            outcome: result.outcome,
            errorType: result.errorType,
            statusCode: result.statusCode,
          })),
        },
      });
      return { status, outageId, checkedAt };
    });
  }

  private async summarize(): Promise<void> {
    const outages = await this.client.networkOutage.findMany({
      where: { observerId: this.observerId, recoveredAt: { not: null }, summarizedAt: null },
      take: 10,
      orderBy: { startedAt: 'asc' },
    });
    for (const original of outages) {
      await this.client.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM network_outages WHERE id = ${original.id} FOR UPDATE`,
        );
        const outage = await tx.networkOutage.findUniqueOrThrow({
          where: { id: original.id },
          include: { observations: { include: { monitor: true } } },
        });
        if (outage.summarizedAt || !outage.recoveredAt) return;
        const now = new Date();
        // Wait for checks already in flight when connectivity returned. They can
        // still register a suppressed result before being scheduled again.
        const inFlight = await tx.scheduledCheck.count({
          where: {
            status: { in: ['RUNNING', 'ENQUEUED'] },
            startedAt: { lte: outage.recoveredAt },
            completedAt: null,
          },
        });
        if (inFlight > 0) return;
        const observations = outage.observations;
        const pending = observations.filter(
          (item) =>
            !item.recheckedAt &&
            item.monitor.lifecycleStatus === 'ACTIVE' &&
            item.monitor.deletedAt === null &&
            item.monitor.configVersion === item.configVersion,
        );
        // Keep scheduling pending observations, including late commits after recovery.
        if (pending.length)
          await tx.monitor.updateMany({
            where: { id: { in: pending.map((item) => item.monitorId) }, nextCheckAt: { gt: now } },
            data: { nextCheckAt: now },
          });
        if (pending.length && now.getTime() - outage.recoveredAt.getTime() < 120_000) return;
        const success = observations.filter((item) => item.outcome === 'SUCCESS').length;
        const failed = observations.filter((item) => item.outcome === 'TARGET_FAILURE').length;
        const skipped = observations.length - success - failed - pending.length;
        const channelIds = Array.isArray(outage.channelIds)
          ? outage.channelIds.filter((id): id is string => typeof id === 'string')
          : [];
        const channels = await tx.notificationChannel.findMany({
          where: { id: { in: channelIds }, type: 'TELEGRAM', enabled: true, deletedAt: null },
        });
        for (const channel of channels) {
          const dedupeKey = `network:${outage.id}:channel:${channel.id}:recovery`;
          await tx.notificationOutbox.upsert({
            where: { dedupeKey },
            update: {},
            create: {
              monitorId: null,
              channelId: channel.id,
              eventType: 'NETWORK_RECOVERY',
              sequence: 1,
              dedupeKey,
              messageId: createStableMessageId(dedupeKey),
              channelTypeSnapshot: channel.type,
              channelDisplayNameSnapshot: channel.displayName,
              encryptedConfigSnapshot: channel.encryptedConfig,
              payloadSafe: {
                eventType: 'NETWORK_RECOVERY',
                monitorName: this.observerId,
                displayUrl: '(감시 PC 외부 연결)',
                occurredAt: outage.recoveredAt.toISOString(),
                networkStartedAt: outage.startedAt.toISOString(),
                durationMs: outage.recoveredAt.getTime() - outage.startedAt.getTime(),
                errorMessageSafe: `대상 재검사: 정상 응답 ${success}개, 대상 오류 ${failed}개, 확인 대기 ${pending.length}개, 중지·설정 변경 등 제외 ${skipped}개. 확인 불가 구간에는 대상 장애·복구를 확정하지 않았습니다.`,
                ...(this.appBaseUrl ? { dashboardUrl: `${this.appBaseUrl}/network` } : {}),
              },
            },
          });
        }
        await tx.networkOutage.update({ where: { id: outage.id }, data: { summarizedAt: now } });
      });
    }
  }
}
