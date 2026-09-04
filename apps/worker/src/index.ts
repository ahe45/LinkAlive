import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma, ScheduledCheckStatus } from '@linkalive/database';
import { createHttpChecker, RedisDestinationLimiter } from '@linkalive/monitoring';
import { TelegramNotificationAdapter } from '@linkalive/notifications';

import { ScheduledCheckProcessor, type CheckJobData } from './check-processor.js';
import {
  CHECK_JOB_NAME,
  CHECK_QUEUE_NAME,
  NOTIFICATION_JOB_NAME,
  NOTIFICATION_QUEUE_NAME,
} from './constants.js';
import { readWorkerConfig } from './config.js';
import {
  closeHealthServer,
  createWorkerHealthServer,
  listenHealthServer,
  outboxPollFreshnessMs,
  WorkerHealth,
} from './health.js';
import { NotificationProcessor } from './notification-processor.js';
import {
  NotificationOutboxDispatcher,
  asNotificationQueue,
  type NotificationJobData,
} from './outbox-dispatcher.js';

const config = readWorkerConfig();
const workerRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const producerRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
  connection: producerRedis,
});
const scheduledChecker = createHttpChecker({
  destinationLimiter: new RedisDestinationLimiter({
    client: {
      eval: async (script, numberOfKeys, ...args) =>
        producerRedis.eval(script, numberOfKeys, ...args),
    },
    maxConcurrent: config.destinationCheckMaxConcurrency,
    maxPerMinute: config.destinationCheckMaxPerMinute,
    leaseMs: config.destinationCheckLeaseMs,
    commandTimeoutMs: config.destinationLimitRedisTimeoutMs,
  }),
});

const telegramAdapter = new TelegramNotificationAdapter();
const checkProcessor = new ScheduledCheckProcessor(
  {
    instanceId: config.instanceId,
    region: config.region,
    leaseMs: config.checkLeaseMs,
    encryptionKey: config.encryptionKey,
    appBaseUrl: config.appBaseUrl,
  },
  prisma,
  scheduledChecker,
);
const notificationProcessor = new NotificationProcessor(
  {
    instanceId: config.instanceId,
    leaseMs: config.notificationLeaseMs,
    encryptionKey: config.encryptionKey,
  },
  { telegram: telegramAdapter },
);
const outboxDispatcher = new NotificationOutboxDispatcher(
  asNotificationQueue(notificationQueue),
  `${config.instanceId}-outbox`,
  config.notificationLeaseMs,
);
const health = new WorkerHealth(
  outboxPollFreshnessMs(config.outboxPollIntervalMs),
  Date.now,
  config.checkPipelineStaleAfterMs,
  config.checkFailureThreshold,
);

const checkWorker = new Worker<CheckJobData>(
  CHECK_QUEUE_NAME,
  async (job) => {
    if (job.name !== CHECK_JOB_NAME) return;
    health.markCheckStarted();
    try {
      await checkProcessor.process(job.data);
      health.markCheckSucceeded();
    } catch (error) {
      health.markCheckFailed();
      throw error;
    }
  },
  {
    connection: workerRedis,
    concurrency: config.checkConcurrency,
    lockDuration: Math.max(30_000, config.checkLeaseMs),
  },
);
const notificationWorker = new Worker<NotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  async (job) => {
    if (job.name !== NOTIFICATION_JOB_NAME) return;
    await notificationProcessor.process(job.data);
  },
  {
    connection: workerRedis,
    concurrency: config.notificationConcurrency,
    lockDuration: Math.max(30_000, config.notificationLeaseMs),
  },
);
const healthServer = createWorkerHealthServer(
  health,
  {
    pingDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    pingProducerRedis: async () => {
      if ((await producerRedis.ping()) !== 'PONG') throw new Error('Producer Redis unavailable');
    },
    pingConsumerRedis: async () => {
      if (!checkWorker.isRunning() || !notificationWorker.isRunning()) {
        throw new Error('Queue consumer is not running');
      }
      if ((await workerRedis.ping()) !== 'PONG') throw new Error('Consumer Redis unavailable');
    },
    hasStalledCheckWork: async (staleBefore) => {
      const stalled = await prisma.scheduledCheck.findFirst({
        where: {
          completedAt: null,
          result: null,
          OR: [
            {
              status: ScheduledCheckStatus.ENQUEUED,
              OR: [
                { enqueuedAt: { lt: staleBefore } },
                { enqueuedAt: null, updatedAt: { lt: staleBefore } },
              ],
            },
            {
              status: ScheduledCheckStatus.RUNNING,
              OR: [
                { startedAt: { lt: staleBefore } },
                { startedAt: null, updatedAt: { lt: staleBefore } },
              ],
            },
          ],
        },
        select: { id: true },
      });
      return stalled !== null;
    },
  },
  config.healthProbeTimeoutMs,
);

checkWorker.on('failed', (_job, _error) => {
  console.error(JSON.stringify({ event: 'check_worker.job_failed' }));
});
checkWorker.on('error', () => {
  console.error(JSON.stringify({ event: 'check_worker.error' }));
});
notificationWorker.on('failed', (_job, _error) => {
  console.error(JSON.stringify({ event: 'notification_worker.job_failed' }));
});
notificationWorker.on('error', () => {
  console.error(JSON.stringify({ event: 'notification_worker.error' }));
});
notificationQueue.on('error', () => {
  console.error(JSON.stringify({ event: 'notification_queue.error' }));
});

let stopped = false;
let outboxTimer: NodeJS.Timeout | undefined;
async function dispatchOutbox(): Promise<void> {
  if (stopped) return;
  try {
    const dispatched = await outboxDispatcher.dispatch();
    health.markOutboxPollSucceeded();
    if (dispatched > 0)
      console.info(JSON.stringify({ event: 'outbox.dispatched', count: dispatched }));
  } catch {
    console.error(JSON.stringify({ event: 'outbox.dispatch_failed' }));
  } finally {
    if (!stopped) {
      outboxTimer = setTimeout(() => void dispatchOutbox(), config.outboxPollIntervalMs);
      outboxTimer.unref?.();
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  health.markStopping();
  if (outboxTimer) clearTimeout(outboxTimer);
  console.info(JSON.stringify({ event: 'worker.stopping', signal }));
  await closeHealthServer(healthServer);
  await Promise.allSettled([
    checkWorker.close(),
    notificationWorker.close(),
    notificationQueue.close(),
  ]);
  await Promise.allSettled([workerRedis.quit(), producerRedis.quit(), prisma.$disconnect()]);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

async function start(): Promise<void> {
  try {
    await listenHealthServer(healthServer, config.healthPort);
    health.markRunning();
    console.info(JSON.stringify({ event: 'worker.started', healthPort: config.healthPort }));
    void dispatchOutbox();
  } catch {
    console.error(JSON.stringify({ event: 'worker.start_failed' }));
    process.exitCode = 1;
    await shutdown('START_FAILURE');
  }
}

void start();
