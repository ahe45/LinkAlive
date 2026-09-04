import { createServer, type Server, type ServerResponse } from 'node:http';

export type WorkerProcessStatus = 'starting' | 'running' | 'stopping';
export type OutboxPollStatus = 'pending' | 'fresh' | 'stale';
export type DependencyStatus = 'ok' | 'unavailable' | 'not_checked';
export type CheckPipelineStatus =
  'idle' | 'active' | 'healthy' | 'failing' | 'stalled' | 'unavailable' | 'not_checked';

export interface WorkerHealthDependencies {
  pingDatabase(): Promise<unknown>;
  pingProducerRedis(): Promise<unknown>;
  pingConsumerRedis(): Promise<unknown>;
  hasStalledCheckWork(staleBefore: Date): Promise<boolean>;
}

export interface CheckActivitySnapshot {
  activeJobs: number;
  consecutiveProcessorFailures: number;
  lastStartedAgoMs: number | null;
  lastSucceededAgoMs: number | null;
  lastFailedAgoMs: number | null;
}

export interface WorkerHealthSnapshot {
  healthy: boolean;
  process: WorkerProcessStatus;
  outboxPoll: OutboxPollStatus;
  checkPipeline: CheckPipelineStatus;
  checkActivity: CheckActivitySnapshot;
  database: DependencyStatus;
  producerRedis: DependencyStatus;
  consumerRedis: DependencyStatus;
}

export async function probeWithin(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<Exclude<DependencyStatus, 'not_checked'>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be positive');
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (status: Exclude<DependencyStatus, 'not_checked'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => finish('unavailable'), timeoutMs);
    timer.unref?.();

    void Promise.resolve()
      .then(operation)
      .then(
        () => finish('ok'),
        () => finish('unavailable'),
      );
  });
}

export class WorkerHealth {
  private processStatus: WorkerProcessStatus = 'starting';
  private lastSuccessfulOutboxPollAt: number | null = null;
  private activeCheckJobs = 0;
  private consecutiveCheckProcessorFailures = 0;
  private lastCheckStartedAt: number | null = null;
  private lastCheckSucceededAt: number | null = null;
  private lastCheckFailedAt: number | null = null;

  constructor(
    private readonly outboxStaleAfterMs: number,
    private readonly now: () => number = Date.now,
    private readonly checkPipelineStaleAfterMs = 10 * 60_000,
    private readonly checkFailureThreshold = 3,
  ) {
    if (!Number.isFinite(outboxStaleAfterMs) || outboxStaleAfterMs <= 0) {
      throw new Error('outboxStaleAfterMs must be positive');
    }
    if (!Number.isFinite(checkPipelineStaleAfterMs) || checkPipelineStaleAfterMs <= 0) {
      throw new Error('checkPipelineStaleAfterMs must be positive');
    }
    if (!Number.isSafeInteger(checkFailureThreshold) || checkFailureThreshold <= 0) {
      throw new Error('checkFailureThreshold must be a positive integer');
    }
  }

  markRunning(): void {
    if (this.processStatus !== 'stopping') this.processStatus = 'running';
  }

  markOutboxPollSucceeded(): void {
    this.lastSuccessfulOutboxPollAt = this.now();
  }

  markCheckStarted(): void {
    const startedAt = this.now();
    if (
      this.lastCheckFailedAt !== null &&
      startedAt - this.lastCheckFailedAt > this.checkPipelineStaleAfterMs
    ) {
      this.consecutiveCheckProcessorFailures = 0;
    }
    this.activeCheckJobs += 1;
    this.lastCheckStartedAt = startedAt;
  }

  markCheckSucceeded(): void {
    this.activeCheckJobs = Math.max(0, this.activeCheckJobs - 1);
    this.consecutiveCheckProcessorFailures = 0;
    this.lastCheckSucceededAt = this.now();
  }

  markCheckFailed(): void {
    this.activeCheckJobs = Math.max(0, this.activeCheckJobs - 1);
    this.consecutiveCheckProcessorFailures += 1;
    this.lastCheckFailedAt = this.now();
  }

  markStopping(): void {
    this.processStatus = 'stopping';
  }

  async inspect(
    dependencies: WorkerHealthDependencies,
    timeoutMs: number,
  ): Promise<WorkerHealthSnapshot> {
    const inspectedAt = this.now();
    const ageMs =
      this.lastSuccessfulOutboxPollAt === null
        ? null
        : inspectedAt - this.lastSuccessfulOutboxPollAt;
    const outboxPoll: OutboxPollStatus =
      ageMs === null ? 'pending' : ageMs <= this.outboxStaleAfterMs ? 'fresh' : 'stale';
    const checkActivity = this.checkActivitySnapshot(inspectedAt);

    if (this.processStatus !== 'running') {
      return {
        healthy: false,
        process: this.processStatus,
        outboxPoll,
        checkPipeline: 'not_checked',
        checkActivity,
        database: 'not_checked',
        producerRedis: 'not_checked',
        consumerRedis: 'not_checked',
      };
    }

    let hasStalledCheckWork = false;
    const [database, producerRedis, consumerRedis, checkLedger] = await Promise.all([
      probeWithin(dependencies.pingDatabase, timeoutMs),
      probeWithin(dependencies.pingProducerRedis, timeoutMs),
      probeWithin(dependencies.pingConsumerRedis, timeoutMs),
      probeWithin(async () => {
        hasStalledCheckWork = await dependencies.hasStalledCheckWork(
          new Date(inspectedAt - this.checkPipelineStaleAfterMs),
        );
      }, timeoutMs),
    ]);
    const process = this.processStatus;
    const hasRecentCheckActivity = [
      checkActivity.lastStartedAgoMs,
      checkActivity.lastSucceededAgoMs,
      checkActivity.lastFailedAgoMs,
    ].some((value) => value !== null && value <= this.checkPipelineStaleAfterMs);
    const checkPipeline: CheckPipelineStatus =
      checkLedger === 'unavailable'
        ? 'unavailable'
        : hasStalledCheckWork
          ? 'stalled'
          : checkActivity.consecutiveProcessorFailures >= this.checkFailureThreshold &&
              checkActivity.lastFailedAgoMs !== null &&
              checkActivity.lastFailedAgoMs <= this.checkPipelineStaleAfterMs
            ? 'failing'
            : checkActivity.activeJobs > 0
              ? 'active'
              : hasRecentCheckActivity
                ? 'healthy'
                : 'idle';
    return {
      healthy:
        process === 'running' &&
        outboxPoll === 'fresh' &&
        ['idle', 'active', 'healthy'].includes(checkPipeline) &&
        database === 'ok' &&
        producerRedis === 'ok' &&
        consumerRedis === 'ok',
      process,
      outboxPoll,
      checkPipeline,
      checkActivity,
      database,
      producerRedis,
      consumerRedis,
    };
  }

  private checkActivitySnapshot(inspectedAt: number): CheckActivitySnapshot {
    const age = (timestamp: number | null): number | null =>
      timestamp === null ? null : Math.max(0, inspectedAt - timestamp);
    return {
      activeJobs: this.activeCheckJobs,
      consecutiveProcessorFailures: this.consecutiveCheckProcessorFailures,
      lastStartedAgoMs: age(this.lastCheckStartedAt),
      lastSucceededAgoMs: age(this.lastCheckSucceededAt),
      lastFailedAgoMs: age(this.lastCheckFailedAt),
    };
  }
}

export function outboxPollFreshnessMs(pollIntervalMs: number): number {
  return Math.max(30_000, pollIntervalMs * 5);
}

function respond(
  response: ServerResponse,
  statusCode: number,
  body: object,
  headOnly: boolean,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(headOnly ? undefined : payload);
}

export function createWorkerHealthServer(
  health: WorkerHealth,
  dependencies: WorkerHealthDependencies,
  probeTimeoutMs: number,
): Server {
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const pathname = request.url?.split('?', 1)[0];
    if (pathname !== '/health') {
      respond(response, 404, { status: 'not_found' }, method === 'HEAD');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      respond(response, 405, { status: 'method_not_allowed' }, false);
      return;
    }

    void health
      .inspect(dependencies, probeTimeoutMs)
      .then((snapshot) => {
        respond(
          response,
          snapshot.healthy ? 200 : 503,
          {
            status: snapshot.healthy ? 'ok' : 'unhealthy',
            checks: {
              process: snapshot.process,
              outboxPoll: snapshot.outboxPoll,
              checkPipeline: snapshot.checkPipeline,
              database: snapshot.database,
              producerRedis: snapshot.producerRedis,
              consumerRedis: snapshot.consumerRedis,
            },
            activity: snapshot.checkActivity,
          },
          method === 'HEAD',
        );
      })
      .catch(() => {
        respond(response, 503, { status: 'unhealthy' }, method === 'HEAD');
      });
  });
  server.headersTimeout = Math.max(3_000, probeTimeoutMs + 1_000);
  server.requestTimeout = Math.max(3_000, probeTimeoutMs + 1_000);
  server.keepAliveTimeout = 1_000;
  return server;
}

export async function listenHealthServer(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

export async function closeHealthServer(server: Server, timeoutMs = 2_000): Promise<void> {
  if (!server.listening) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close(finish);
    server.closeIdleConnections();
  });
}
