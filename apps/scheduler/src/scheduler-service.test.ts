import { describe, expect, it, vi } from 'vitest';

import { CheckDispatcher, type CheckQueuePort } from './check-dispatcher.js';
import { SchedulerService } from './scheduler-service.js';
import type { DispatchCandidate, SchedulerStore } from './store.js';

function makeStore(candidates: DispatchCandidate[] = []): SchedulerStore {
  return {
    createDueChecks: vi.fn().mockResolvedValue([{ id: 'new', configVersion: 3 }]),
    findDispatchCandidates: vi.fn().mockResolvedValue(candidates),
    claimForDispatch: vi.fn().mockResolvedValue(true),
    markEnqueued: vi.fn().mockResolvedValue(undefined),
    releaseDispatchClaim: vi.fn().mockResolvedValue(undefined),
  };
}

describe('scheduler and durable dispatcher', () => {
  it('creates the durable DB record before dispatching', async () => {
    const calls: string[] = [];
    const store = makeStore([{ id: 'check-1', configVersion: 2, status: 'PENDING' }]);
    vi.mocked(store.createDueChecks).mockImplementation(async () => {
      calls.push('db');
      return [{ id: 'check-1', configVersion: 2 }];
    });
    const queue: CheckQueuePort = {
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockImplementation(async () => calls.push('queue')),
    };
    const dispatcher = new CheckDispatcher(store, queue, 'test', 60_000);
    const service = new SchedulerService(store, dispatcher, 10, 10, () => new Date(0));
    await service.runOnce();
    expect(calls).toEqual(['db', 'queue']);
  });

  it('re-enqueues a terminal Redis job when the DB record is unfinished', async () => {
    const store = makeStore([{ id: 'check-1', configVersion: 2, status: 'ENQUEUED' }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const add = vi.fn().mockResolvedValue(undefined);
    const queue: CheckQueuePort = {
      getJob: vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue('failed'), remove }),
      add,
    };
    const dispatcher = new CheckDispatcher(store, queue, 'test', 60_000);
    expect(await dispatcher.dispatch(new Date(0), 10)).toBe(1);
    expect(remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(
      'check-url',
      expect.objectContaining({ scheduledCheckId: 'check-1' }),
      expect.any(Object),
    );
  });

  it('releases a DB claim after queue failure', async () => {
    const store = makeStore([{ id: 'check-1', configVersion: 2, status: 'PENDING' }]);
    const queue: CheckQueuePort = {
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const dispatcher = new CheckDispatcher(store, queue, 'test', 60_000);
    expect(await dispatcher.dispatch(new Date(0), 10)).toBe(0);
    expect(store.releaseDispatchClaim).toHaveBeenCalledWith(
      'check-1',
      'test',
      expect.not.stringContaining('redis unavailable'),
    );
  });
});
