import { Redis } from 'ioredis';
import { getConfig } from './config.js';

let redis: Redis | undefined;

export function getRedis(): Redis {
  redis ??= new Redis(getConfig().redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  return redis;
}

export function closeRedis(): void {
  redis?.disconnect();
  redis = undefined;
}
