import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createHttpChecker } from './checker.js';

describe('real HTTP response cleanup', () => {
  it('sends the redirect cookie over HTTP without leaking it into the next check', async () => {
    const received: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers.cookie);
      if (request.headers.cookie === 'session=ready') {
        response.writeHead(200);
      } else {
        response.writeHead(302, { location: '/', 'set-cookie': 'session=ready; Path=/; HttpOnly' });
      }
      response.write('ready');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const checker = createHttpChecker();
      for (let i = 0; i < 2; i++) {
        const result = await checker({ url: `http://127.0.0.1:${port}/` });
        expect(result.outcome).toBe('SUCCESS');
        expect(result.redirectCount).toBe(1);
      }
      expect(received).toEqual([undefined, 'session=ready', undefined, 'session=ready']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it.each([
    ['/', undefined, 'SUCCESS', null],
    ['/redirect', undefined, 'SUCCESS', null],
    ['/failure', undefined, 'TARGET_FAILURE', 'HTTP_STATUS_MISMATCH'],
    ['/', 'ready', 'SUCCESS', null],
  ] as const)(
    'safely closes an unfinished body: %s, keyword=%s',
    async (path, keyword, outcome, errorType) => {
      const server = createServer((request, response) => {
        response.writeHead(
          request.url === '/redirect' ? 302 : request.url === '/failure' ? 503 : 200,
          {
            ...(request.url === '/redirect' ? { location: '/' } : {}),
            'content-type': 'text/plain',
          },
        );
        response.write('ready');
        // Leave the body open so the checker must cancel the actual Undici stream.
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const result = await createHttpChecker()({
          url: `http://127.0.0.1:${port}${path}`,
          source: 'TEST',
          ...(keyword ? { expectedKeyword: keyword } : {}),
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(result.outcome).toBe(outcome);
        expect(result.errorType).toBe(errorType);
        expect(result.redirectCount).toBe(path === '/redirect' ? 1 : 0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
