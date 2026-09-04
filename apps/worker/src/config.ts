import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface WorkerConfig {
  redisUrl: string;
  encryptionKey: Buffer;
  healthPort: number;
  healthProbeTimeoutMs: number;
  instanceId: string;
  region: string;
  checkConcurrency: number;
  notificationConcurrency: number;
  destinationCheckMaxConcurrency: number;
  destinationCheckMaxPerMinute: number;
  destinationCheckLeaseMs: number;
  destinationLimitRedisTimeoutMs: number;
  checkLeaseMs: number;
  notificationLeaseMs: number;
  outboxPollIntervalMs: number;
  checkPipelineStaleAfterMs: number;
  checkFailureThreshold: number;
  appBaseUrl: string | null;
}

function normalizeAppBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.length > 2_048) throw new Error('APP_BASE_URL is too long');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('APP_BASE_URL must be a valid http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use http:// or https://');
  }
  // This value is copied into the otherwise secret-free notification outbox.
  // Reject components that could accidentally persist credentials or tokens.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('APP_BASE_URL cannot contain credentials, query parameters, or a fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readWorkerConfig(): WorkerConfig {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
  const parsedRedis = new URL(redisUrl);
  if (parsedRedis.protocol !== 'redis:' && parsedRedis.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  const encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
  if (encryptionKey.byteLength !== 32) {
    throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  const appBaseUrl = normalizeAppBaseUrl(process.env.APP_BASE_URL);
  const checkLeaseMs = integerEnv('SCHEDULED_CHECK_LEASE_MS', 5 * 60_000, 60_000, 30 * 60_000);

  const configuredInstance = process.env.INSTANCE_ID?.trim().slice(0, 60);
  return {
    redisUrl,
    encryptionKey,
    healthPort: integerEnv('WORKER_HEALTH_PORT', 4_102, 1, 65_535),
    healthProbeTimeoutMs: integerEnv('WORKER_HEALTH_PROBE_TIMEOUT_MS', 2_000, 100, 10_000),
    instanceId:
      `worker-${configuredInstance || `${hostname()}-${process.pid}`}-${randomUUID()}`.slice(
        0,
        120,
      ),
    region: process.env.WORKER_REGION?.slice(0, 80) || 'default',
    checkConcurrency: integerEnv('CHECK_WORKER_CONCURRENCY', 20, 1, 500),
    notificationConcurrency: integerEnv('NOTIFICATION_WORKER_CONCURRENCY', 5, 1, 100),
    destinationCheckMaxConcurrency: integerEnv('DESTINATION_CHECK_MAX_CONCURRENCY', 4, 1, 1_000),
    destinationCheckMaxPerMinute: integerEnv('DESTINATION_CHECK_MAX_PER_MINUTE', 60, 1, 100_000),
    destinationCheckLeaseMs: integerEnv('DESTINATION_CHECK_LEASE_MS', 45_000, 31_000, 10 * 60_000),
    destinationLimitRedisTimeoutMs: integerEnv(
      'DESTINATION_LIMIT_REDIS_TIMEOUT_MS',
      1_000,
      100,
      10_000,
    ),
    checkLeaseMs,
    notificationLeaseMs: integerEnv('NOTIFICATION_LEASE_MS', 60_000, 30_000, 10 * 60_000),
    outboxPollIntervalMs: integerEnv('OUTBOX_POLL_INTERVAL_MS', 2_000, 250, 60_000),
    checkPipelineStaleAfterMs: integerEnv(
      'WORKER_CHECK_PIPELINE_STALE_AFTER_MS',
      Math.max(2 * 60_000, checkLeaseMs * 2),
      60_000,
      60 * 60_000,
    ),
    checkFailureThreshold: integerEnv('WORKER_CHECK_FAILURE_THRESHOLD', 3, 1, 100),
    appBaseUrl,
  };
}
