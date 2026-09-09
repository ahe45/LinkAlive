import { describe, expect, it, vi } from 'vitest';
import { checkReferenceUrls } from './reference-check.js';
import type { MonitorCheckResult } from './types.js';

describe('reference connectivity request policy', () => {
  it('uses HEAD without redirects and returns every result even if a runner throws', async () => {
    const httpResponse = { outcome: 'SUCCESS', statusCode: 503 } as MonitorCheckResult;
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error('private transport details'))
      .mockResolvedValueOnce(httpResponse);
    const results = await checkReferenceUrls(
      ['https://example.com/', 'https://example.org/'],
      runner,
    );
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/',
        method: 'HEAD',
        timeoutMs: 5000,
        expectedStatusMin: 100,
        expectedStatusMax: 599,
        followRedirects: false,
        maxRedirects: 0,
      }),
    );
    expect(results[0]).toMatchObject({
      outcome: 'PLATFORM_ERROR',
      statusCode: null,
      errorType: 'PLATFORM_ERROR',
    });
    expect(JSON.stringify(results)).not.toContain('private transport details');
    expect(results[1]).toBe(httpResponse);
  });
});
