import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

const rootEnvPath = resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnvPath)) loadEnv({ path: rootEnvPath, override: false, quiet: true });

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  WEB_ORIGIN: z.string().url().max(2_048).default('http://localhost:3001'),
  WEB_ALLOWED_ORIGINS: z.string().max(8_192).default(''),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  ADMIN_USERNAME: z.string().min(1).max(160).default('admin'),
  AUTH_SECRET: z.string().min(32),
  AUTH_COOKIE_NAME: z.string().min(1).default('linkalive_session'),
  COOKIE_SECURE: booleanFromString,
  ENCRYPTION_KEY: z.string().min(1),
  CHECK_QUEUE_NAME: z.string().default('linkalive-checks'),
  NOTIFICATION_QUEUE_NAME: z.string().default('linkalive-notifications'),
  DESTINATION_CHECK_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(1_000).default(4),
  DESTINATION_CHECK_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
  DESTINATION_CHECK_LEASE_MS: z.coerce
    .number()
    .int()
    .min(31_000)
    .max(10 * 60_000)
    .default(45_000),
  DESTINATION_LIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: booleanFromString,
});

export type ApiConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  webOrigins: string[];
  databaseUrl: string;
  redisUrl: string;
  adminUsername: string;
  authSecret: string;
  authCookieName: string;
  cookieSecure: boolean;
  encryptionKey: Buffer;
  checkQueueName: string;
  notificationQueueName: string;
  destinationCheckMaxConcurrency: number;
  destinationCheckMaxPerMinute: number;
  destinationCheckLeaseMs: number;
  destinationLimitRedisTimeoutMs: number;
  telegramBotToken: string;
  logLevel: string;
  trustProxy: boolean;
};

let cached: ApiConfig | undefined;

export function getConfig(): ApiConfig {
  if (cached) return cached;

  const parsed = schema.parse(process.env);
  if (parsed.AUTH_SECRET === 'replace-with-at-least-32-random-characters') {
    throw new Error('AUTH_SECRET must be changed from the example value');
  }
  const rawWebOrigins = [
    parsed.WEB_ORIGIN,
    ...parsed.WEB_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
  ].filter(Boolean);
  const webOrigins = [...new Set(rawWebOrigins.map((origin) => normalizeWebOrigin(origin)))];
  const redisProtocol = new URL(parsed.REDIS_URL).protocol;
  if (redisProtocol !== 'redis:' && redisProtocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  if (parsed.NODE_ENV === 'production') {
    for (const origin of webOrigins) {
      const webOrigin = new URL(origin);
      const loopbackOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(webOrigin.hostname);
      if (!loopbackOrigin && (webOrigin.protocol !== 'https:' || !parsed.COOKIE_SECURE)) {
        throw new Error('Production web origins must use HTTPS and COOKIE_SECURE=true');
      }
    }
  }
  const encryptionKey = Buffer.from(parsed.ENCRYPTION_KEY, 'base64');
  if (encryptionKey.byteLength !== 32) {
    throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  cached = {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.API_PORT,
    webOrigins,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    adminUsername: parsed.ADMIN_USERNAME,
    authSecret: parsed.AUTH_SECRET,
    authCookieName: parsed.AUTH_COOKIE_NAME,
    cookieSecure: parsed.COOKIE_SECURE,
    encryptionKey,
    checkQueueName: parsed.CHECK_QUEUE_NAME,
    notificationQueueName: parsed.NOTIFICATION_QUEUE_NAME,
    destinationCheckMaxConcurrency: parsed.DESTINATION_CHECK_MAX_CONCURRENCY,
    destinationCheckMaxPerMinute: parsed.DESTINATION_CHECK_MAX_PER_MINUTE,
    destinationCheckLeaseMs: parsed.DESTINATION_CHECK_LEASE_MS,
    destinationLimitRedisTimeoutMs: parsed.DESTINATION_LIMIT_REDIS_TIMEOUT_MS,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    logLevel: parsed.LOG_LEVEL,
    trustProxy: parsed.TRUST_PROXY,
  };
  return cached;
}

function normalizeWebOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('WEB_ORIGIN and WEB_ALLOWED_ORIGINS must contain valid web origins');
  }

  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'WEB_ORIGIN and WEB_ALLOWED_ORIGINS must contain only http:// or https:// origins',
    );
  }

  return origin.origin;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
