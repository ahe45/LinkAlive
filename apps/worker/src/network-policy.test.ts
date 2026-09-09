import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@linkalive/database';
import type { MonitorCheckResult } from '@linkalive/monitoring';
import { referenceStatus, isNetworkFailure } from './network-policy.js';
import { NetworkGuard } from './network-guard.js';

function result(overrides: Partial<MonitorCheckResult> = {}): MonitorCheckResult {
  return {
    source: 'SCHEDULED',
    outcome: 'TARGET_FAILURE',
    errorType: 'CONNECT_TIMEOUT',
    errorMessageSafe: 'timeout',
    startedAt: new Date(),
    finishedAt: new Date(),
    statusCode: null,
    ttfbMs: null,
    totalMs: 10,
    finalUrlDisplay: 'https://example.com/',
    redirectCount: 0,
    inspectedBodyBytes: 0,
    ...overrides,
  };
}

describe('monitoring host connectivity', () => {
  afterEach(() => vi.useRealTimers());

  it('polls every 60 seconds normally, every 10 seconds during an outage, and keeps processing summaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T05:00:00Z'));
    let observer = {
      status: 'UNKNOWN',
      activeOutageId: null as string | null,
      checkedAt: null as Date | null,
    };
    let online = true;
    const probe = vi.fn(async () =>
      result(online ? { statusCode: 200, outcome: 'SUCCESS', errorType: null } : {}),
    );
    const settings = {
      enabled: true,
      version: 1,
      urls: ['https://example.com/', 'https://example.org/', 'https://example.net/'],
      channelIds: [],
    };
    const summaries = vi.fn().mockResolvedValue([]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      networkSettings: { findUnique: vi.fn().mockResolvedValue(settings) },
      networkObserver: {
        upsert: vi.fn().mockResolvedValue({}),
        findUniqueOrThrow: vi.fn(async () => observer),
        update: vi.fn(async ({ data }) => {
          observer = { ...observer, ...data };
          return observer;
        }),
      },
      networkOutage: {
        create: vi.fn().mockResolvedValue({ id: 'outage-1' }),
        update: vi.fn().mockResolvedValue({}),
        findMany: summaries,
      },
      monitor: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const client = {
      ...tx,
      $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as PrismaClient;
    const guard = new NetworkGuard('pc', null, client, probe);
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      await guard.poll();
    }
    expect(probe).toHaveBeenCalledTimes(3);
    expect(summaries).toHaveBeenCalledTimes(6);
    online = false;
    vi.advanceTimersByTime(10_000);
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(6);
    expect(observer.status).toBe('OFFLINE');
    vi.advanceTimersByTime(10_000);
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(9);
    online = true;
    vi.advanceTimersByTime(10_000);
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(12);
    expect(observer.status).toBe('ONLINE');
    vi.advanceTimersByTime(50_000);
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(12);
    vi.advanceTimersByTime(10_000);
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(15);
    // An immediate inspection after a target failure also changes the cadence.
    online = false;
    vi.advanceTimersByTime(2_000);
    await guard.assess(result(), vi.fn());
    expect(observer.status).toBe('OFFLINE');
    expect(probe).toHaveBeenCalledTimes(18);
    vi.advanceTimersByTime(7_000);
    expect(guard.nextPollDelayMs()).toBe(3_000);
    vi.advanceTimersByTime(guard.nextPollDelayMs());
    await guard.poll();
    expect(probe).toHaveBeenCalledTimes(21);
  });

  it('requires multiple failed references and accepts any HTTP response as connectivity', () => {
    expect(referenceStatus([result()])).toBe('UNKNOWN');
    expect(referenceStatus([result(), result()])).toBe('OFFLINE');
    expect(referenceStatus([result(), result({ statusCode: 503 })])).toBe('ONLINE');
    expect(referenceStatus([result(), result({ outcome: 'PLATFORM_ERROR' })])).toBe('UNKNOWN');
    expect(referenceStatus([result(), result({ errorType: 'TLS_ERROR' })])).toBe('UNKNOWN');
  });

  it('does not suppress HTTP or content errors even when external references are unreachable', async () => {
    const guard = new NetworkGuard('pc', null);
    const inspect = vi.spyOn(guard, 'inspect');
    for (const input of [
      result({ statusCode: 503, errorType: 'HTTP_STATUS_MISMATCH' }),
      result({ statusCode: 200, errorType: 'CONTENT_MISMATCH' }),
    ]) {
      expect(isNetworkFailure(input)).toBe(false);
      expect((await guard.assess(input, vi.fn())).result).toEqual(input);
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it('preserves failed checks when the feature is disabled', async () => {
    const guard = new NetworkGuard('pc', null);
    vi.spyOn(guard, 'inspect').mockResolvedValue({
      status: 'DISABLED',
      outageId: null,
      checkedAt: new Date(),
    });
    const input = result();
    expect(await guard.assess(input, vi.fn())).toEqual({ result: input, outageId: null });
  });

  it('records an inconclusive result when both the target and reference network fail', async () => {
    const guard = new NetworkGuard('pc', null);
    vi.spyOn(guard, 'inspect').mockResolvedValue({
      status: 'OFFLINE',
      outageId: 'outage',
      checkedAt: new Date(),
    });
    const retry = vi.fn();
    expect(await guard.assess(result(), retry)).toMatchObject({
      outageId: 'outage',
      result: { outcome: 'INCONCLUSIVE' },
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it('rechecks a transient target failure after the reference network has recovered', async () => {
    const guard = new NetworkGuard('pc', null);
    vi.spyOn(guard, 'inspect').mockResolvedValue({
      status: 'ONLINE',
      outageId: null,
      checkedAt: new Date(),
    });
    const recovered = result({ statusCode: 200, outcome: 'SUCCESS', errorType: null });
    expect(await guard.assess(result(), vi.fn().mockResolvedValue(recovered))).toEqual({
      result: recovered,
      outageId: null,
    });
  });

  it('checks the network again if the retry also fails', async () => {
    const guard = new NetworkGuard('pc', null);
    const inspect = vi
      .spyOn(guard, 'inspect')
      .mockResolvedValueOnce({ status: 'ONLINE', outageId: null, checkedAt: new Date() })
      .mockResolvedValueOnce({ status: 'OFFLINE', outageId: 'outage', checkedAt: new Date() });
    expect(await guard.assess(result(), vi.fn().mockResolvedValue(result()))).toMatchObject({
      outageId: 'outage',
      result: { outcome: 'INCONCLUSIVE' },
    });
    expect(inspect).toHaveBeenLastCalledWith(true);
  });
});
