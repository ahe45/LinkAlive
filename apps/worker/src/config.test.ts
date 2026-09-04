import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readWorkerConfig } from './config.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
let originalEnvironment: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnvironment = { ...process.env };
  process.env.ENCRYPTION_KEY = encryptionKey;
  delete process.env.WORKER_CHECK_PIPELINE_STALE_AFTER_MS;
  delete process.env.WORKER_CHECK_FAILURE_THRESHOLD;
});

afterEach(() => {
  process.env = originalEnvironment;
});

describe('worker configuration', () => {
  it('normalizes a safe dashboard base path', () => {
    process.env.APP_BASE_URL = 'https://status.example.com/linkalive/';

    expect(readWorkerConfig().appBaseUrl).toBe('https://status.example.com/linkalive');
  });

  it.each([
    'https://user:password@example.com',
    'https://example.com/?token=secret',
    'https://example.com/#secret',
    'file:///tmp/dashboard',
  ])('rejects an unsafe dashboard URL without echoing it: %s', (value) => {
    process.env.APP_BASE_URL = value;

    expect(() => readWorkerConfig()).toThrow(/APP_BASE_URL/);
  });

  it('derives a conservative pipeline stale window from the check lease', () => {
    process.env.SCHEDULED_CHECK_LEASE_MS = '60000';

    const config = readWorkerConfig();
    expect(config.checkPipelineStaleAfterMs).toBe(120_000);
    expect(config.checkFailureThreshold).toBe(3);
  });

  it('accepts explicit worker pipeline health thresholds', () => {
    process.env.WORKER_CHECK_PIPELINE_STALE_AFTER_MS = '90000';
    process.env.WORKER_CHECK_FAILURE_THRESHOLD = '7';

    const config = readWorkerConfig();
    expect(config.checkPipelineStaleAfterMs).toBe(90_000);
    expect(config.checkFailureThreshold).toBe(7);
  });

  it.each([
    ['WORKER_CHECK_PIPELINE_STALE_AFTER_MS', '59999'],
    ['WORKER_CHECK_FAILURE_THRESHOLD', '0'],
  ])('rejects an invalid %s value', (name, value) => {
    process.env[name] = value;

    expect(() => readWorkerConfig()).toThrow(name);
  });

  it.each([
    ['DESTINATION_CHECK_MAX_CONCURRENCY', '0'],
    ['DESTINATION_CHECK_MAX_PER_MINUTE', '0'],
    ['DESTINATION_CHECK_LEASE_MS', '30000'],
    ['DESTINATION_LIMIT_REDIS_TIMEOUT_MS', '99'],
  ])('rejects an unsafe destination limiter setting: %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => readWorkerConfig()).toThrow(name);
  });
});
