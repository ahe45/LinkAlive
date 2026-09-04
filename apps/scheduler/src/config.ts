import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface SchedulerConfig {
  redisUrl: string;
  healthPort: number;
  pollIntervalMs: number;
  dueBatchSize: number;
  dispatchBatchSize: number;
  leaseMs: number;
  instanceId: string;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readSchedulerConfig(): SchedulerConfig {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  const configuredInstance = process.env.INSTANCE_ID?.trim().slice(0, 60);
  return {
    redisUrl,
    healthPort: integerEnv('SCHEDULER_HEALTH_PORT', 4_101, 1, 65_535),
    pollIntervalMs: integerEnv('SCHEDULER_POLL_INTERVAL_MS', 5_000, 250, 60_000),
    dueBatchSize: integerEnv('SCHEDULER_DUE_BATCH_SIZE', 100, 1, 1_000),
    dispatchBatchSize: integerEnv('SCHEDULER_DISPATCH_BATCH_SIZE', 200, 1, 2_000),
    leaseMs: integerEnv('SCHEDULED_CHECK_LEASE_MS', 5 * 60_000, 60_000, 30 * 60_000),
    instanceId:
      `scheduler-${configuredInstance || `${hostname()}-${process.pid}`}-${randomUUID()}`.slice(
        0,
        120,
      ),
  };
}
