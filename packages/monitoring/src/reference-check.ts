import { checkUrl } from './checker.js';
import type { MonitorCheckConfig, MonitorCheckResult } from './types.js';

/** Identical request policy for automatic connectivity probes and manual tests. */
export async function checkReferenceUrls(
  urls: readonly string[],
  runner: (config: MonitorCheckConfig) => Promise<MonitorCheckResult> = checkUrl,
): Promise<MonitorCheckResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      const startedAt = new Date();
      try {
        return await runner({
          url,
          method: 'HEAD',
          timeoutMs: 5_000,
          expectedStatusMin: 100,
          expectedStatusMax: 599,
          followRedirects: false,
          maxRedirects: 0,
          source: 'TEST',
        });
      } catch {
        const finishedAt = new Date();
        return {
          source: 'TEST',
          outcome: 'PLATFORM_ERROR',
          startedAt,
          finishedAt,
          statusCode: null,
          ttfbMs: null,
          totalMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          errorType: 'PLATFORM_ERROR',
          errorMessageSafe: '연결 테스트를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
          finalUrlDisplay: url,
          redirectCount: 0,
          inspectedBodyBytes: 0,
        };
      }
    }),
  );
}
