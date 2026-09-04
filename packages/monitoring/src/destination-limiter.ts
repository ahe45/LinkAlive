import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { DestinationLimiterError } from './errors.js';
import type { DestinationLease, DestinationLimiter, SafeDestination } from './types.js';

const WINDOW_MS = 60_000;
const MAX_DESTINATION_ADDRESSES = 64;

const ACQUIRE_SCRIPT = `
local token = ARGV[1]
local lease_ms = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local max_concurrent = tonumber(ARGV[4])
local max_per_window = tonumber(ARGV[5])
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at = now_ms + lease_ms

for index = 1, #KEYS, 2 do
  local active_key = KEYS[index]
  local rate_key = KEYS[index + 1]
  redis.call('ZREMRANGEBYSCORE', active_key, '-inf', now_ms)

  if redis.call('ZCARD', active_key) >= max_concurrent then
    local oldest = redis.call('ZRANGE', active_key, 0, 0, 'WITHSCORES')
    local retry_after = 1
    if oldest[2] then
      retry_after = math.max(1, tonumber(oldest[2]) - now_ms)
    end
    return {0, 1, retry_after}
  end

  local rate_count = tonumber(redis.call('GET', rate_key) or '0')
  local rate_ttl = redis.call('PTTL', rate_key)
  if rate_count > 0 and rate_ttl < 0 then
    redis.call('PEXPIRE', rate_key, window_ms)
    rate_ttl = window_ms
  end
  if rate_count >= max_per_window then
    return {0, 2, math.max(1, rate_ttl)}
  end
end

for index = 1, #KEYS, 2 do
  local active_key = KEYS[index]
  local rate_key = KEYS[index + 1]
  redis.call('ZADD', active_key, expires_at, token)
  redis.call('PEXPIRE', active_key, lease_ms + 1000)
  local rate_count = redis.call('INCR', rate_key)
  if rate_count == 1 or redis.call('PTTL', rate_key) < 0 then
    redis.call('PEXPIRE', rate_key, window_ms)
  end
end

return {1, 0, 0}
`;

const RELEASE_SCRIPT = `
local token = ARGV[1]
local removed = 0
for index = 1, #KEYS do
  removed = removed + redis.call('ZREM', KEYS[index], token)
  if redis.call('ZCARD', KEYS[index]) == 0 then
    redis.call('DEL', KEYS[index])
  end
end
return removed
`;

export interface RedisScriptClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface RedisDestinationLimiterOptions {
  client: RedisScriptClient;
  maxConcurrent: number;
  maxPerMinute: number;
  leaseMs: number;
  commandTimeoutMs?: number;
}

function assertInteger(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalAddress(address: string, family: 4 | 6): string {
  if (isIP(address) !== family) throw new Error('invalid destination address');
  if (family === 4) {
    return address
      .split('.')
      .map((octet) => String(Number(octet)))
      .join('.');
  }
  // WHATWG URL serialization compresses equivalent IPv6 spellings into the
  // same representation, preventing textual aliases from bypassing an IP key.
  return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function destinationSubjects(destination: SafeDestination): string[] {
  if (destination.addresses.length > MAX_DESTINATION_ADDRESSES) {
    throw new DestinationLimiterError(
      '대상의 주소가 너무 많아 보호 제한을 안전하게 적용할 수 없습니다.',
    );
  }

  const hostname = destination.url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const subjects = new Set<string>([`host:${hostname}`]);
  for (const address of destination.addresses) {
    try {
      subjects.add(`ip${address.family}:${canonicalAddress(address.address, address.family)}`);
    } catch {
      throw new DestinationLimiterError(
        '검증된 목적지 주소에 보호 제한을 안전하게 적용할 수 없습니다.',
      );
    }
  }
  return [...subjects];
}

function destinationKeys(destination: SafeDestination): {
  acquireKeys: string[];
  activeKeys: string[];
} {
  const bases = destinationSubjects(destination).map(
    (subject) => `linkalive:destination-limit:{global}:${digest(subject)}`,
  );
  return {
    acquireKeys: bases.flatMap((base) => [`${base}:active`, `${base}:rate`]),
    activeKeys: bases.map((base) => `${base}:active`),
  };
}

function resultInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    return /^-?\d+$/.test(text) ? Number(text) : null;
  }
  return null;
}

function acquisitionStatus(result: unknown): number | null {
  return Array.isArray(result) ? resultInteger(result[0]) : null;
}

export class RedisDestinationLimiter implements DestinationLimiter {
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: RedisDestinationLimiterOptions) {
    assertInteger('maxConcurrent', options.maxConcurrent, 1, 1_000);
    assertInteger('maxPerMinute', options.maxPerMinute, 1, 100_000);
    // HTTP checks have a hard 30 second ceiling. A longer lease prevents a
    // healthy long request from losing its concurrency slot prematurely.
    assertInteger('leaseMs', options.leaseMs, 31_000, 10 * 60_000);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 1_000;
    assertInteger('commandTimeoutMs', this.commandTimeoutMs, 100, 10_000);
  }

  async acquire(destination: SafeDestination, signal?: AbortSignal): Promise<DestinationLease> {
    const { acquireKeys, activeKeys } = destinationKeys(destination);
    const token = randomUUID();

    let rawResult: unknown;
    try {
      rawResult = await this.runCommand(
        () =>
          this.options.client.eval(
            ACQUIRE_SCRIPT,
            acquireKeys.length,
            ...acquireKeys,
            token,
            this.options.leaseMs,
            WINDOW_MS,
            this.options.maxConcurrent,
            this.options.maxPerMinute,
          ),
        signal,
      );
    } catch {
      throw new DestinationLimiterError(
        '검사 보호 제한을 확인할 수 없어 이번 검사를 시작하지 않았습니다.',
      );
    }

    const status = acquisitionStatus(rawResult);
    if (status === 0) {
      throw new DestinationLimiterError(
        '같은 대상에 대한 검사 보호 제한으로 이번 검사를 실행하지 않았습니다.',
      );
    }
    if (status !== 1) {
      throw new DestinationLimiterError(
        '검사 보호 제한의 응답을 확인할 수 없어 이번 검사를 시작하지 않았습니다.',
      );
    }

    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        try {
          await this.runCommand(() =>
            this.options.client.eval(RELEASE_SCRIPT, activeKeys.length, ...activeKeys, token),
          );
          released = true;
        } catch {
          // The lease remains fail-safe: Redis removes the sorted-set member
          // when the lease expires even if explicit release was interrupted.
          throw new DestinationLimiterError(
            '검사 보호 제한을 안전하게 해제하지 못해 결과를 확정하지 않았습니다.',
          );
        }
      },
    };
  }

  private async runCommand<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('destination limiter aborted');

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(new Error('destination limiter aborted')));
      const timer = setTimeout(
        () => finish(() => reject(new Error('destination limiter command timeout'))),
        this.commandTimeoutMs,
      );
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      Promise.resolve()
        .then(operation)
        .then(
          (value) => finish(() => resolve(value)),
          () => finish(() => reject(new Error('destination limiter backend unavailable'))),
        );
    });
  }
}
