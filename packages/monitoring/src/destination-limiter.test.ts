import { describe, expect, it, vi } from 'vitest';

import { RedisDestinationLimiter, type RedisScriptClient } from './destination-limiter.js';
import { DestinationLimiterError } from './errors.js';
import type { SafeDestination } from './types.js';

const destination: SafeDestination = {
  url: new URL('https://example.com/private?token=secret'),
  addresses: [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ],
};

function limiter(client: RedisScriptClient): RedisDestinationLimiter {
  return new RedisDestinationLimiter({
    client,
    maxConcurrent: 4,
    maxPerMinute: 60,
    leaseMs: 45_000,
    commandTimeoutMs: 500,
  });
}

describe('Redis destination limiter', () => {
  it('atomically reserves hashed hostname and validated IP dimensions', async () => {
    const evalMock = vi.fn().mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce(3);
    const lease = await limiter({ eval: evalMock }).acquire(destination);

    expect(evalMock).toHaveBeenCalledTimes(1);
    const acquireCall = evalMock.mock.calls[0] as unknown[];
    expect(acquireCall[1]).toBe(6);
    expect(String(acquireCall[0])).toContain('ZREMRANGEBYSCORE');
    expect(String(acquireCall[0])).toContain("redis.call('TIME')");
    expect(acquireCall.slice(2, 8).every((key) => String(key).includes('{global}'))).toBe(true);
    expect(acquireCall.join(' ')).not.toContain('example.com');
    expect(acquireCall.join(' ')).not.toContain('93.184.216.34');
    expect(acquireCall.join(' ')).not.toContain('secret');

    await lease.release();
    await lease.release();

    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[1]?.[1]).toBe(3);
  });

  it.each([
    [0, 1, 250],
    [0, 2, 4_000],
  ])('fails closed when a destination limit is reached (%j)', async (...response) => {
    const client: RedisScriptClient = { eval: vi.fn().mockResolvedValue(response) };

    await expect(limiter(client).acquire(destination)).rejects.toMatchObject({
      name: 'DestinationLimiterError',
      outcome: 'PLATFORM_ERROR',
      errorType: 'PLATFORM_ERROR',
    });
  });

  it('does not disclose Redis or destination details when the backend fails', async () => {
    const client: RedisScriptClient = {
      eval: vi.fn().mockRejectedValue(new Error('redis://password@host token=secret')),
    };

    const error = await limiter(client)
      .acquire(destination)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DestinationLimiterError);
    expect(String(error)).not.toContain('password');
    expect(String(error)).not.toContain('secret');
  });

  it('uses lease expiry as the fallback when explicit release fails', async () => {
    const evalMock = vi
      .fn()
      .mockResolvedValueOnce([1, 0, 0])
      .mockRejectedValueOnce(new Error('connection lost'));
    const lease = await limiter({ eval: evalMock }).acquire(destination);

    await expect(lease.release()).rejects.toMatchObject({ outcome: 'PLATFORM_ERROR' });
    expect(String(evalMock.mock.calls[0]?.[0])).toContain('PEXPIRE');
  });

  it('maps equivalent IPv6 spellings to the same distributed key', async () => {
    const firstEval = vi.fn().mockResolvedValue([1, 0, 0]);
    const secondEval = vi.fn().mockResolvedValue([1, 0, 0]);
    const first = {
      url: new URL('https://one.example.com/'),
      addresses: [{ address: '2606:4700:4700:0:0:0:0:1111', family: 6 as const }],
    };
    const second = {
      url: new URL('https://two.example.com/'),
      addresses: [{ address: '2606:4700:4700::1111', family: 6 as const }],
    };

    await limiter({ eval: firstEval }).acquire(first);
    await limiter({ eval: secondEval }).acquire(second);

    const firstIpKeys = firstEval.mock.calls[0]?.slice(4, 6);
    const secondIpKeys = secondEval.mock.calls[0]?.slice(4, 6);
    expect(firstIpKeys).toEqual(secondIpKeys);
  });

  it('fails closed on cancellation without invoking Redis', async () => {
    const controller = new AbortController();
    controller.abort();
    const evalMock = vi.fn();

    await expect(
      limiter({ eval: evalMock }).acquire(destination, controller.signal),
    ).rejects.toMatchObject({ outcome: 'PLATFORM_ERROR' });
    expect(evalMock).not.toHaveBeenCalled();
  });
});
