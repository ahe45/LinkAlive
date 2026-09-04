import { afterEach, describe, expect, it, vi } from 'vitest';

import { readWorkerConfig } from './config.js';
import {
  outboxPollFreshnessMs,
  probeWithin,
  WorkerHealth,
  type WorkerHealthDependencies,
} from './health.js';

const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalHealthPort = process.env.WORKER_HEALTH_PORT;

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  if (originalHealthPort === undefined) delete process.env.WORKER_HEALTH_PORT;
  else process.env.WORKER_HEALTH_PORT = originalHealthPort;
});

function healthyDependencies(): WorkerHealthDependencies {
  return {
    pingDatabase: vi.fn().mockResolvedValue(undefined),
    pingProducerRedis: vi.fn().mockResolvedValue('PONG'),
    pingConsumerRedis: vi.fn().mockResolvedValue('PONG'),
    hasStalledCheckWork: vi.fn().mockResolvedValue(false),
  };
}

describe('worker health', () => {
  it('requires a recent outbox poll and both dependencies', async () => {
    const health = new WorkerHealth(500, () => 1_000);
    const dependencies = healthyDependencies();
    health.markRunning();
    health.markOutboxPollSucceeded();

    expect(await health.inspect(dependencies, 100)).toEqual({
      healthy: true,
      process: 'running',
      outboxPoll: 'fresh',
      checkPipeline: 'idle',
      checkActivity: {
        activeJobs: 0,
        consecutiveProcessorFailures: 0,
        lastStartedAgoMs: null,
        lastSucceededAgoMs: null,
        lastFailedAgoMs: null,
      },
      database: 'ok',
      producerRedis: 'ok',
      consumerRedis: 'ok',
    });
  });

  it('returns only a safe unavailable state when a dependency rejects', async () => {
    const health = new WorkerHealth(500, () => 1_000);
    health.markRunning();
    health.markOutboxPollSucceeded();
    const snapshot = await health.inspect(
      {
        pingDatabase: vi.fn().mockRejectedValue(new Error('mysql://user:secret@host/db')),
        pingProducerRedis: vi.fn().mockResolvedValue('PONG'),
        pingConsumerRedis: vi.fn().mockResolvedValue('PONG'),
        hasStalledCheckWork: vi.fn().mockResolvedValue(false),
      },
      100,
    );

    expect(snapshot).toMatchObject({ healthy: false, database: 'unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('bounds a dependency probe that never settles', async () => {
    const startedAt = Date.now();
    const result = await probeWithin(() => new Promise(() => undefined), 20);
    expect(result).toBe('unavailable');
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('does not probe dependencies after shutdown starts', async () => {
    const health = new WorkerHealth(500, () => 1_000);
    const dependencies = healthyDependencies();
    health.markRunning();
    health.markOutboxPollSucceeded();
    health.markStopping();

    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: false,
      process: 'stopping',
      database: 'not_checked',
      producerRedis: 'not_checked',
      consumerRedis: 'not_checked',
    });
    expect(dependencies.pingDatabase).not.toHaveBeenCalled();
    expect(dependencies.pingProducerRedis).not.toHaveBeenCalled();
    expect(dependencies.pingConsumerRedis).not.toHaveBeenCalled();
    expect(dependencies.hasStalledCheckWork).not.toHaveBeenCalled();
  });

  it('cannot report healthy when shutdown starts during dependency probes', async () => {
    const health = new WorkerHealth(500, () => 1_000);
    let releaseDatabase: (() => void) | undefined;
    const pingDatabase = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseDatabase = resolve;
        }),
    );
    health.markRunning();
    health.markOutboxPollSucceeded();

    const inspection = health.inspect(
      {
        pingDatabase,
        pingProducerRedis: vi.fn().mockResolvedValue('PONG'),
        pingConsumerRedis: vi.fn().mockResolvedValue('PONG'),
        hasStalledCheckWork: vi.fn().mockResolvedValue(false),
      },
      100,
    );
    await vi.waitFor(() => expect(pingDatabase).toHaveBeenCalledOnce());
    health.markStopping();
    releaseDatabase?.();

    expect(await inspection).toMatchObject({ healthy: false, process: 'stopping' });
  });

  it('reports unhealthy when the queue consumer connection is unavailable', async () => {
    const health = new WorkerHealth(500, () => 1_000);
    const dependencies = healthyDependencies();
    dependencies.pingConsumerRedis = vi.fn().mockRejectedValue(new Error('consumer stopped'));
    health.markRunning();
    health.markOutboxPollSucceeded();

    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: false,
      consumerRedis: 'unavailable',
    });
  });

  it('reports active and recent successful check processor activity', async () => {
    let now = 1_000;
    const health = new WorkerHealth(500, () => now, 600, 3);
    const dependencies = healthyDependencies();
    health.markRunning();
    health.markOutboxPollSucceeded();
    health.markCheckStarted();
    now = 1_100;

    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: true,
      checkPipeline: 'active',
      checkActivity: {
        activeJobs: 1,
        consecutiveProcessorFailures: 0,
        lastStartedAgoMs: 100,
        lastSucceededAgoMs: null,
      },
    });

    health.markCheckSucceeded();
    now = 1_250;
    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: true,
      checkPipeline: 'healthy',
      checkActivity: {
        activeJobs: 0,
        consecutiveProcessorFailures: 0,
        lastStartedAgoMs: 250,
        lastSucceededAgoMs: 150,
      },
    });
  });

  it('becomes unhealthy after consecutive processor failures and resets after success', async () => {
    let now = 1_000;
    const health = new WorkerHealth(500, () => now, 600, 3);
    const dependencies = healthyDependencies();
    health.markRunning();
    health.markOutboxPollSucceeded();

    for (let index = 0; index < 3; index += 1) {
      health.markCheckStarted();
      now += 10;
      health.markCheckFailed();
    }

    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: false,
      checkPipeline: 'failing',
      checkActivity: {
        activeJobs: 0,
        consecutiveProcessorFailures: 3,
        lastFailedAgoMs: 0,
      },
    });

    health.markCheckStarted();
    now += 10;
    health.markCheckSucceeded();
    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: true,
      checkPipeline: 'healthy',
      checkActivity: { consecutiveProcessorFailures: 0 },
    });
  });

  it('does not keep an otherwise idle worker unhealthy for an old failure streak', async () => {
    let now = 1_000;
    const health = new WorkerHealth(500, () => now, 600, 2);
    const dependencies = healthyDependencies();
    health.markRunning();
    health.markOutboxPollSucceeded();
    for (let index = 0; index < 2; index += 1) {
      health.markCheckStarted();
      health.markCheckFailed();
    }

    now = 1_601;
    health.markOutboxPollSucceeded();
    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: true,
      checkPipeline: 'idle',
      checkActivity: { consecutiveProcessorFailures: 2 },
    });

    health.markCheckStarted();
    health.markCheckFailed();
    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: true,
      checkPipeline: 'healthy',
      checkActivity: { consecutiveProcessorFailures: 1 },
    });
  });

  it('reports stalled ledger work using the configured cutoff', async () => {
    const health = new WorkerHealth(500, () => 10_000, 2_000, 3);
    const dependencies = healthyDependencies();
    dependencies.hasStalledCheckWork = vi.fn().mockResolvedValue(true);
    health.markRunning();
    health.markOutboxPollSucceeded();

    expect(await health.inspect(dependencies, 100)).toMatchObject({
      healthy: false,
      checkPipeline: 'stalled',
    });
    expect(dependencies.hasStalledCheckWork).toHaveBeenCalledWith(new Date(8_000));
  });

  it('reports an unavailable ledger probe without leaking its rejection', async () => {
    const health = new WorkerHealth(500, () => 1_000, 600, 3);
    const dependencies = healthyDependencies();
    dependencies.hasStalledCheckWork = vi
      .fn()
      .mockRejectedValue(new Error('mysql://user:secret@host/db'));
    health.markRunning();
    health.markOutboxPollSucceeded();

    const snapshot = await health.inspect(dependencies, 100);
    expect(snapshot).toMatchObject({ healthy: false, checkPipeline: 'unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('uses a generous freshness window for normal dispatch batches', () => {
    expect(outboxPollFreshnessMs(2_000)).toBe(30_000);
    expect(outboxPollFreshnessMs(10_000)).toBe(50_000);
  });

  it('validates the health server port', () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    process.env.WORKER_HEALTH_PORT = '65536';
    expect(() => readWorkerConfig()).toThrow('WORKER_HEALTH_PORT');
  });
});
