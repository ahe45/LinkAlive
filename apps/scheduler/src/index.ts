import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '@linkalive/database';

import { CheckDispatcher, asCheckQueue, type CheckJobData } from './check-dispatcher.js';
import { CHECK_QUEUE_NAME } from './constants.js';
import { readSchedulerConfig } from './config.js';
import {
  closeHealthServer,
  createSchedulerHealthServer,
  listenHealthServer,
  SchedulerHealth,
  schedulerTickFreshnessMs,
} from './health.js';
import { SchedulerService } from './scheduler-service.js';
import { PrismaSchedulerStore } from './store.js';

const config = readSchedulerConfig();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
const queue = new Queue<CheckJobData>(CHECK_QUEUE_NAME, { connection: redis });
const store = new PrismaSchedulerStore();
const dispatcher = new CheckDispatcher(
  store,
  asCheckQueue(queue),
  config.instanceId,
  config.leaseMs,
);
const service = new SchedulerService(
  store,
  dispatcher,
  config.dueBatchSize,
  config.dispatchBatchSize,
);
const health = new SchedulerHealth(schedulerTickFreshnessMs(config.pollIntervalMs));
const healthServer = createSchedulerHealthServer(health);

let stopped = false;
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (stopped) return;
  try {
    const result = await service.runOnce();
    const redisReply = await redis.ping();
    if (redisReply !== 'PONG') throw new Error('Redis health check failed');
    health.markTickSucceeded();
    if (result.created > 0 || result.dispatched > 0) {
      console.info(JSON.stringify({ event: 'scheduler.tick', ...result }));
    }
  } catch {
    console.error(JSON.stringify({ event: 'scheduler.tick_failed' }));
  } finally {
    if (!stopped) {
      timer = setTimeout(() => void tick(), config.pollIntervalMs);
      timer.unref?.();
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  health.markStopping();
  if (timer) clearTimeout(timer);
  console.info(JSON.stringify({ event: 'scheduler.stopping', signal }));
  await closeHealthServer(healthServer);
  await Promise.allSettled([queue.close(), redis.quit(), prisma.$disconnect()]);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

async function start(): Promise<void> {
  try {
    await listenHealthServer(healthServer, config.healthPort);
    health.markRunning();
    console.info(JSON.stringify({ event: 'scheduler.started', healthPort: config.healthPort }));
    void tick();
  } catch {
    console.error(JSON.stringify({ event: 'scheduler.start_failed' }));
    process.exitCode = 1;
    await shutdown('START_FAILURE');
  }
}

void start();
