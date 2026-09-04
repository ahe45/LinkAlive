import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfigForTests } from '../src/common/config.js';

const originalEnvironment = { ...process.env };
const validEnvironment = {
  DATABASE_URL: 'mysql://linkalive:linkalive@127.0.0.1:3306/linkalive',
  REDIS_URL: 'redis://127.0.0.1:6379',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'a-safe-development-password',
  AUTH_SECRET: 'a-safe-session-secret-with-more-than-32-characters',
  ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
  WEB_ORIGIN: 'http://localhost:3000',
  COOKIE_SECURE: 'false',
};

describe('API configuration safety', () => {
  beforeEach(() => {
    process.env = { ...originalEnvironment, ...validEnvironment };
    resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    resetConfigForTests();
  });

  it('rejects the documented placeholder administrator password', () => {
    process.env.ADMIN_PASSWORD = 'change-this-before-running';
    expect(() => getConfig()).toThrow(/ADMIN_PASSWORD/);
  });

  it('accepts the configured four-character local administrator password', () => {
    process.env.ADMIN_PASSWORD = '1234';
    expect(getConfig().adminPassword).toBe('1234');
  });

  it('rejects the documented placeholder session secret', () => {
    process.env.AUTH_SECRET = 'replace-with-at-least-32-random-characters';
    expect(() => getConfig()).toThrow(/AUTH_SECRET/);
  });

  it('requires HTTPS and a secure cookie for a public production origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'http://monitor.example.com';
    expect(() => getConfig()).toThrow(/HTTPS/);
  });

  it('allows an insecure cookie only for loopback production smoke tests', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'http://[::1]:3000';
    expect(getConfig().cookieSecure).toBe(false);
  });

  it.each(['https://example.com/path', 'https://user:password@example.com', 'file:///tmp/ui'])(
    'rejects a value that is not a bare web origin: %s',
    (origin) => {
      process.env.WEB_ORIGIN = origin;
      expect(() => getConfig()).toThrow(/WEB_ORIGIN/);
    },
  );

  it('rejects a non-Redis queue URL before startup', () => {
    process.env.REDIS_URL = 'https://example.com/redis';
    expect(() => getConfig()).toThrow(/REDIS_URL/);
  });

  it.each([
    ['DESTINATION_CHECK_MAX_CONCURRENCY', '0'],
    ['DESTINATION_CHECK_MAX_PER_MINUTE', '0'],
    ['DESTINATION_CHECK_LEASE_MS', '30000'],
    ['DESTINATION_LIMIT_REDIS_TIMEOUT_MS', '99'],
  ])('rejects an unsafe destination limiter setting: %s=%s', (name, value) => {
    process.env[name] = value;
    expect(() => getConfig()).toThrow();
  });
});
