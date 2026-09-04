import { afterEach, describe, expect, it } from 'vitest';

import { readSchedulerConfig } from './config.js';
import { SchedulerHealth, schedulerTickFreshnessMs } from './health.js';

const originalHealthPort = process.env.SCHEDULER_HEALTH_PORT;

afterEach(() => {
  if (originalHealthPort === undefined) delete process.env.SCHEDULER_HEALTH_PORT;
  else process.env.SCHEDULER_HEALTH_PORT = originalHealthPort;
});

describe('scheduler health', () => {
  it('becomes healthy only after a successful recent tick', () => {
    let now = 1_000;
    const health = new SchedulerHealth(500, () => now);

    expect(health.snapshot()).toMatchObject({
      healthy: false,
      process: 'starting',
      tick: 'pending',
    });
    health.markRunning();
    expect(health.snapshot()).toMatchObject({
      healthy: false,
      process: 'running',
      tick: 'pending',
    });

    health.markTickSucceeded();
    expect(health.snapshot()).toMatchObject({ healthy: true, tick: 'fresh' });

    now += 501;
    expect(health.snapshot()).toMatchObject({ healthy: false, tick: 'stale' });
  });

  it('reports unhealthy while stopping even with a fresh tick', () => {
    const health = new SchedulerHealth(1_000, () => 1_000);
    health.markRunning();
    health.markTickSucceeded();
    health.markStopping();
    expect(health.snapshot()).toMatchObject({ healthy: false, process: 'stopping', tick: 'fresh' });
  });

  it('allows three polling intervals with a minimum startup-safe window', () => {
    expect(schedulerTickFreshnessMs(1_000)).toBe(15_000);
    expect(schedulerTickFreshnessMs(10_000)).toBe(30_000);
  });

  it('validates the health server port', () => {
    process.env.SCHEDULER_HEALTH_PORT = '0';
    expect(() => readSchedulerConfig()).toThrow('SCHEDULER_HEALTH_PORT');
  });
});
