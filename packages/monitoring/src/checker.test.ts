import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { createHttpChecker } from './checker.js';
import { DestinationLimiterError } from './errors.js';
import type {
  DestinationLimiter,
  DnsResolver,
  HttpTransport,
  ResolvedAddress,
  SafeDestination,
  TransportRequest,
  TransportResponse,
} from './types.js';

class StaticResolver implements DnsResolver {
  readonly calls: string[] = [];
  constructor(private readonly byHost: Record<string, readonly ResolvedAddress[]>) {}
  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    this.calls.push(hostname);
    return this.byHost[hostname] ?? [{ address: '93.184.216.34', family: 4 }];
  }
}

interface ResponseFixture {
  statusCode: number;
  headers?: Record<string, string>;
  chunks?: Array<string | Buffer>;
}

class FixtureTransport implements HttpTransport {
  readonly calls: string[] = [];
  constructor(private readonly fixtures: ResponseFixture[]) {}
  async request(
    destination: SafeDestination,
    _request: TransportRequest,
  ): Promise<TransportResponse> {
    this.calls.push(destination.url.toString());
    const fixture = this.fixtures.shift();
    if (!fixture) throw new Error('Missing fixture');
    const body = Readable.from((fixture.chunks ?? []).map((chunk) => Buffer.from(chunk)));
    return {
      statusCode: fixture.statusCode,
      headers: fixture.headers ?? {},
      body,
      close: async () => undefined,
    };
  }
}

class ThrowingTransport implements HttpTransport {
  constructor(private readonly error: Error) {}
  async request(): Promise<TransportResponse> {
    throw this.error;
  }
}

describe('HTTP checker', () => {
  it('limits and releases every DNS-validated redirect destination', async () => {
    const resolver = new StaticResolver({
      'example.com': [{ address: '93.184.216.34', family: 4 }],
      'www.example.com': [{ address: '93.184.216.35', family: 4 }],
    });
    const releases: string[] = [];
    const acquisitions: string[] = [];
    const destinationLimiter: DestinationLimiter = {
      acquire: vi.fn(async (target) => {
        acquisitions.push(`${target.url.hostname}:${target.addresses[0]?.address}`);
        return {
          release: async () => {
            releases.push(target.url.hostname);
          },
        };
      }),
    };
    const checker = createHttpChecker({
      resolver,
      destinationLimiter,
      transport: new FixtureTransport([
        { statusCode: 302, headers: { location: 'https://www.example.com/ready' } },
        { statusCode: 200 },
      ]),
    });

    const result = await checker({ url: 'https://example.com' });

    expect(result.outcome).toBe('SUCCESS');
    expect(acquisitions).toEqual(['example.com:93.184.216.34', 'www.example.com:93.184.216.35']);
    expect(releases).toEqual(['example.com', 'www.example.com']);
  });

  it('does not contact or mark a target down when the distributed limiter rejects it', async () => {
    const transport = new FixtureTransport([{ statusCode: 200 }]);
    const checker = createHttpChecker({
      transport,
      resolver: new StaticResolver({}),
      destinationLimiter: {
        acquire: async () => {
          throw new DestinationLimiterError('검사 보호 제한으로 실행하지 않았습니다.');
        },
      },
    });

    const result = await checker({ url: 'https://example.com', source: 'SCHEDULED' });

    expect(result).toMatchObject({ outcome: 'PLATFORM_ERROR', errorType: 'PLATFORM_ERROR' });
    expect(transport.calls).toHaveLength(0);
  });

  it('sanitizes an unexpected limiter backend failure as a platform result', async () => {
    const transport = new FixtureTransport([{ statusCode: 200 }]);
    const checker = createHttpChecker({
      transport,
      resolver: new StaticResolver({}),
      destinationLimiter: {
        acquire: async () => {
          throw new Error('redis://user:secret@example.internal');
        },
      },
    });

    const result = await checker({ url: 'https://example.com?token=private' });

    expect(result).toMatchObject({ outcome: 'PLATFORM_ERROR', errorType: 'PLATFORM_ERROR' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(transport.calls).toHaveLength(0);
  });

  it('turns a limiter release failure into a platform result instead of a target failure', async () => {
    const checker = createHttpChecker({
      transport: new FixtureTransport([{ statusCode: 503 }]),
      resolver: new StaticResolver({}),
      destinationLimiter: {
        acquire: async () => ({
          release: async () => {
            throw new Error('redis unavailable');
          },
        }),
      },
    });

    const result = await checker({ url: 'https://example.com', source: 'SCHEDULED' });

    expect(result).toMatchObject({ outcome: 'PLATFORM_ERROR', errorType: 'PLATFORM_ERROR' });
  });

  it('keeps manual and test sources out of the transport semantics', async () => {
    const transport = new FixtureTransport([{ statusCode: 204 }]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });
    const result = await checker({ url: 'https://example.com', source: 'MANUAL' });
    expect(result).toMatchObject({ source: 'MANUAL', outcome: 'SUCCESS', statusCode: 204 });
  });

  it('rejects a HEAD and keyword combination before making a request', async () => {
    const transport = new FixtureTransport([]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });
    const result = await checker({
      url: 'https://example.com',
      method: 'HEAD',
      expectedKeyword: 'ready',
    });
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(transport.calls).toHaveLength(0);
  });

  it('checks a keyword across response chunk boundaries', async () => {
    const transport = new FixtureTransport([
      { statusCode: 200, chunks: ['service is re', 'ady now'] },
    ]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });
    const result = await checker({ url: 'https://example.com', expectedKeyword: 'ready' });
    expect(result.outcome).toBe('SUCCESS');
    expect(result.inspectedBodyBytes).toBeGreaterThan(0);
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)(
    'keeps normal %s keyword checks working at the decoded 64 KiB boundary',
    async (encoding, compress) => {
      const decoded = Buffer.alloc(64 * 1024, 'x');
      decoded.write('ready', decoded.length - Buffer.byteLength('ready'), 'utf8');
      const encoded = compress(decoded);
      const transport = new FixtureTransport([
        {
          statusCode: 200,
          headers: {
            'content-encoding': encoding,
            'content-length': String(encoded.byteLength),
          },
          chunks: [encoded],
        },
      ]);
      const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });

      const result = await checker({ url: 'https://example.com', expectedKeyword: 'ready' });

      expect(result).toMatchObject({ outcome: 'SUCCESS', inspectedBodyBytes: 64 * 1024 });
    },
  );

  it('rejects a compressed response whose declared wire size exceeds 256 KiB', async () => {
    const encoded = gzipSync('ready');
    const transport = new FixtureTransport([
      {
        statusCode: 200,
        headers: {
          'content-encoding': 'gzip',
          'content-length': String(256 * 1024 + 1),
        },
        chunks: [encoded],
      },
    ]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });

    const result = await checker({ url: 'https://example.com', expectedKeyword: 'ready' });

    expect(result).toMatchObject({
      outcome: 'TARGET_FAILURE',
      errorType: 'RESPONSE_LIMIT_EXCEEDED',
      inspectedBodyBytes: 0,
    });
  });

  it('stops an oversized near-zero-output gzip stream without Content-Length', async () => {
    const emptyMember = gzipSync(Buffer.alloc(0));
    const memberCount = Math.floor((256 * 1024) / emptyMember.byteLength) + 1;
    const encoded = Buffer.concat(Array.from({ length: memberCount }, () => emptyMember));
    const chunks = Array.from({ length: Math.ceil(encoded.byteLength / 4_096) }, (_, index) =>
      encoded.subarray(index * 4_096, (index + 1) * 4_096),
    );
    expect(encoded.byteLength).toBeGreaterThan(256 * 1024);
    const transport = new FixtureTransport([
      {
        statusCode: 200,
        headers: { 'content-encoding': 'gzip' },
        chunks,
      },
    ]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });

    const result = await checker({ url: 'https://example.com', expectedKeyword: 'ready' });

    expect(result).toMatchObject({
      outcome: 'TARGET_FAILURE',
      errorType: 'RESPONSE_LIMIT_EXCEEDED',
      inspectedBodyBytes: 0,
    });
  });

  it('classifies unexpected status without exposing response data', async () => {
    const transport = new FixtureTransport([{ statusCode: 503, chunks: ['private response'] }]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });
    const result = await checker({ url: 'https://example.com?token=secret' });
    expect(result).toMatchObject({
      outcome: 'TARGET_FAILURE',
      errorType: 'HTTP_STATUS_MISMATCH',
      statusCode: 503,
      finalUrlDisplay: 'https://example.com/',
    });
    expect(result.errorMessageSafe).not.toContain('private response');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('re-resolves and allows a private redirect destination', async () => {
    const resolver = new StaticResolver({
      'example.com': [{ address: '93.184.216.34', family: 4 }],
      'internal.example': [{ address: '10.0.0.1', family: 4 }],
    });
    const transport = new FixtureTransport([
      { statusCode: 302, headers: { location: 'https://internal.example/admin' } },
      { statusCode: 200 },
    ]);
    const checker = createHttpChecker({ transport, resolver });
    const result = await checker({ url: 'https://example.com' });
    expect(result).toMatchObject({ outcome: 'SUCCESS', statusCode: 200 });
    expect(resolver.calls).toEqual(['example.com', 'internal.example']);
  });

  it('allows HTTPS to HTTP downgrade redirects', async () => {
    const transport = new FixtureTransport([
      { statusCode: 301, headers: { location: 'http://example.com/path' } },
      { statusCode: 200 },
    ]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });
    const result = await checker({ url: 'https://example.com' });
    expect(result).toMatchObject({ outcome: 'SUCCESS', statusCode: 200 });
    expect(transport.calls).toEqual(['https://example.com/', 'http://example.com/path']);
  });

  it('stops content inspection at 64 KiB', async () => {
    const transport = new FixtureTransport([
      { statusCode: 200, chunks: [Buffer.alloc(70 * 1024, 'x'), 'needle'] },
    ]);
    const checker = createHttpChecker({ transport, resolver: new StaticResolver({}) });
    const result = await checker({ url: 'https://example.com', expectedKeyword: 'needle' });
    expect(result).toMatchObject({ outcome: 'TARGET_FAILURE', errorType: 'CONTENT_MISMATCH' });
    expect(result.inspectedBodyBytes).toBe(64 * 1024);
  });

  it('does not count an unexpected checker bug as a target outage', async () => {
    const checker = createHttpChecker({
      transport: new ThrowingTransport(new TypeError('internal detail')),
      resolver: new StaticResolver({}),
    });
    const result = await checker({ url: 'https://example.com' });
    expect(result).toMatchObject({ outcome: 'PLATFORM_ERROR', errorType: 'PLATFORM_ERROR' });
    expect(result.errorMessageSafe).not.toContain('internal detail');
  });

  it('classifies a known socket failure as a target network error', async () => {
    const error = Object.assign(new Error('socket detail'), { code: 'ECONNRESET' });
    const checker = createHttpChecker({
      transport: new ThrowingTransport(error),
      resolver: new StaticResolver({}),
    });
    const result = await checker({ url: 'https://example.com' });
    expect(result).toMatchObject({ outcome: 'TARGET_FAILURE', errorType: 'NETWORK_ERROR' });
  });
});
