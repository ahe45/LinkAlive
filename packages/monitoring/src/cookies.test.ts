import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createHttpChecker } from './checker.js';
import type { TransportRequest } from './types.js';

describe('redirect cookies', () => {
  it('completes a queue round trip and starts each check with a fresh session', async () => {
    const requests: Array<{ url: string; cookie: string | undefined }> = [];
    const checker = createHttpChecker({
      resolver: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
      transport: {
        request: async ({ url }, options) => {
          requests.push({ url: url.href, cookie: options.cookie });
          const granted = options.cookie === 'access=yes';
          const queue = url.hostname === 'queue.example.com';
          const returning = url.search === '?ticket=ok';
          return {
            statusCode: granted ? 200 : 302,
            headers: granted
              ? {}
              : {
                  location: queue
                    ? 'https://app.example.com/?ticket=ok'
                    : returning
                      ? '/'
                      : 'https://queue.example.com/',
                  ...(returning ? { 'set-cookie': ['access=yes; Secure; HttpOnly; Path=/'] } : {}),
                },
            body: Readable.from([]),
            close: async () => undefined,
          };
        },
      },
    });
    const results = await Promise.all([
      checker({ url: 'https://app.example.com/' }),
      checker({ url: 'https://app.example.com/' }),
    ]);
    for (const result of results) {
      expect(result.outcome).toBe('SUCCESS');
      expect(result.redirectCount).toBe(3);
    }
    expect(requests.filter((r) => r.url === 'https://app.example.com/' && !r.cookie)).toHaveLength(
      2,
    );
    expect(
      requests.filter((r) => r.url === 'https://queue.example.com/').every((r) => !r.cookie),
    ).toBe(true);
  });

  it.each([
    ['https://other.example.net/', 'session=secret; Path=/', undefined],
    ['https://app.example.com/public', 'session=secret; Path=/private', undefined],
    ['http://app.example.com/', 'session=secret; Secure; Path=/', undefined],
    ['https://app.example.com/next', 'session=secret; Max-Age=0; Path=/', undefined],
    ['https://other.example.net/', 'session=secret; Domain=example.net; Path=/', undefined],
    ['https://queue.example.com/', 'session=shared; Domain=example.com; Path=/', 'session=shared'],
  ])('respects cookie scope for %s (%s)', async (location, setCookie, expected) => {
    const requests: TransportRequest[] = [];
    const checker = createHttpChecker({
      resolver: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
      transport: {
        request: async (_destination, options) => {
          requests.push(options);
          return {
            statusCode: requests.length === 1 ? 302 : 200,
            headers: requests.length === 1 ? { location, 'set-cookie': setCookie } : {},
            body: Readable.from([]),
            close: async () => undefined,
          };
        },
      },
    });
    expect((await checker({ url: 'https://app.example.com/' })).outcome).toBe('SUCCESS');
    expect(requests[1]?.cookie).toBe(expected);
  });

  it.each([false, true])('still stops a redirect loop (changing cookies: %s)', async (changing) => {
    let count = 0;
    const checker = createHttpChecker({
      resolver: { resolve: async () => [{ address: '93.184.216.34', family: 4 }] },
      transport: {
        request: async () => ({
          statusCode: 302,
          headers: { location: '/', ...(changing ? { 'set-cookie': `n=${++count}; Path=/` } : {}) },
          body: Readable.from([]),
          close: async () => undefined,
        }),
      },
    });
    const result = await checker({ url: 'https://app.example.com/' });
    expect(result.errorType).toBe('REDIRECT_ERROR');
    expect(result.redirectCount).toBe(changing ? 5 : 1);
  });
});
