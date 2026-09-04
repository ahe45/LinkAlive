import { createServer, type Server, type ServerResponse } from 'node:http';

export type SchedulerProcessStatus = 'starting' | 'running' | 'stopping';
export type SchedulerTickStatus = 'pending' | 'fresh' | 'stale';

export interface SchedulerHealthSnapshot {
  healthy: boolean;
  process: SchedulerProcessStatus;
  tick: SchedulerTickStatus;
}

export class SchedulerHealth {
  private processStatus: SchedulerProcessStatus = 'starting';
  private lastSuccessfulTickAt: number | null = null;

  constructor(
    private readonly staleAfterMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new Error('staleAfterMs must be positive');
    }
  }

  markRunning(): void {
    if (this.processStatus !== 'stopping') this.processStatus = 'running';
  }

  markTickSucceeded(): void {
    this.lastSuccessfulTickAt = this.now();
  }

  markStopping(): void {
    this.processStatus = 'stopping';
  }

  snapshot(): SchedulerHealthSnapshot {
    const ageMs =
      this.lastSuccessfulTickAt === null ? null : this.now() - this.lastSuccessfulTickAt;
    const tick: SchedulerTickStatus =
      ageMs === null ? 'pending' : ageMs <= this.staleAfterMs ? 'fresh' : 'stale';

    return {
      healthy: this.processStatus === 'running' && tick === 'fresh',
      process: this.processStatus,
      tick,
    };
  }
}

export function schedulerTickFreshnessMs(pollIntervalMs: number): number {
  return Math.max(15_000, pollIntervalMs * 3);
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

export function createSchedulerHealthServer(health: SchedulerHealth): Server {
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

    const snapshot = health.snapshot();
    respond(
      response,
      snapshot.healthy ? 200 : 503,
      {
        status: snapshot.healthy ? 'ok' : 'unhealthy',
        checks: { process: snapshot.process, schedulerTick: snapshot.tick },
      },
      method === 'HEAD',
    );
  });
  server.headersTimeout = 3_000;
  server.requestTimeout = 3_000;
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
