import { randomBytes, randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDestinationLimiter } from '@linkalive/monitoring';

const runRedisIntegration = process.env.CI === 'true' && Boolean(process.env.REDIS_URL);
const describeRedis = runRedisIntegration ? describe : describe.skip;

describeRedis('Redis destination limiter integration', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    await redis.connect();
    await redis.ping();
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('shares concurrency and minute counters through the atomic Lua boundary', async () => {
    const limiter = new RedisDestinationLimiter({
      client: {
        eval: async (script, numberOfKeys, ...args) => redis.eval(script, numberOfKeys, ...args),
      },
      maxConcurrent: 1,
      maxPerMinute: 2,
      leaseMs: 31_000,
      commandTimeoutMs: 2_000,
    });
    const destination = {
      url: new URL(`https://limit-${randomUUID()}.example.test/`),
      addresses: [
        {
          address: `2606:4700:4700::${randomBytes(2).toString('hex')}`,
          family: 6 as const,
        },
      ],
    };

    const first = await limiter.acquire(destination);
    await expect(limiter.acquire(destination)).rejects.toMatchObject({
      outcome: 'PLATFORM_ERROR',
    });

    await first.release();
    const second = await limiter.acquire(destination);
    await second.release();

    await expect(limiter.acquire(destination)).rejects.toMatchObject({
      outcome: 'PLATFORM_ERROR',
    });
  });
});
