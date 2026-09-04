import { Queue, type JobsOptions } from 'bullmq';

import { CHECK_JOB_NAME } from './constants.js';
import type { SchedulerStore } from './store.js';

export interface CheckJobData {
  scheduledCheckId: string;
  configVersion: number;
}

export interface CheckQueuePort {
  getJob(id: string): Promise<
    | {
        getState(): Promise<string>;
        remove(): Promise<void>;
      }
    | undefined
  >;
  add(name: string, data: CheckJobData, options: JobsOptions): Promise<unknown>;
}

async function ensureQueueJob(queue: CheckQueuePort, data: CheckJobData): Promise<void> {
  const existing = await queue.getJob(data.scheduledCheckId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    } else {
      return;
    }
  }
  await queue.add(CHECK_JOB_NAME, data, {
    jobId: data.scheduledCheckId,
    attempts: 1,
    removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 50_000 },
  });
}

export class CheckDispatcher {
  constructor(
    private readonly store: SchedulerStore,
    private readonly queue: CheckQueuePort,
    private readonly owner: string,
    private readonly leaseMs: number,
  ) {}

  async dispatch(now: Date, limit: number): Promise<number> {
    const candidates = await this.store.findDispatchCandidates(now, limit);
    let dispatched = 0;
    for (const candidate of candidates) {
      const leaseUntil = new Date(now.getTime() + this.leaseMs);
      if (!(await this.store.claimForDispatch(candidate.id, this.owner, now, leaseUntil))) continue;
      try {
        await ensureQueueJob(this.queue, {
          scheduledCheckId: candidate.id,
          configVersion: candidate.configVersion,
        });
        await this.store.markEnqueued(candidate.id, this.owner, now, leaseUntil);
        dispatched += 1;
      } catch {
        await this.store.releaseDispatchClaim(
          candidate.id,
          this.owner,
          '검사 큐에 작업을 등록하지 못했습니다.',
        );
      }
    }
    return dispatched;
  }
}

export function asCheckQueue(queue: Queue<CheckJobData>): CheckQueuePort {
  return queue;
}
