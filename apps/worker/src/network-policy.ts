import type { MonitorCheckResult } from '@linkalive/monitoring';

export function referenceCheckIntervalMs(status: string, outageId: string | null): number {
  // Keep checking an unresolved outage quickly even if a probe is inconclusive.
  return status === 'OFFLINE' || outageId !== null ? 10_000 : 60_000;
}

const NETWORK_ERRORS = new Set([
  'DNS_ERROR',
  'CONNECT_TIMEOUT',
  'CONNECTION_REFUSED',
  'TTFB_TIMEOUT',
  'REQUEST_TIMEOUT',
  'NETWORK_ERROR',
]);

export function isNetworkFailure(result: MonitorCheckResult): boolean {
  return (
    result.outcome === 'TARGET_FAILURE' &&
    result.statusCode === null &&
    NETWORK_ERRORS.has(result.errorType ?? '')
  );
}

export function referenceStatus(results: MonitorCheckResult[]): 'ONLINE' | 'OFFLINE' | 'UNKNOWN' {
  // Any HTTP response proves connectivity, even a 4xx/5xx or HEAD rejection.
  if (results.some((result) => result.statusCode !== null)) return 'ONLINE';
  if (results.length >= 2 && results.every(isNetworkFailure)) return 'OFFLINE';
  return 'UNKNOWN';
}

export function inconclusiveNetworkResult(result: MonitorCheckResult): MonitorCheckResult {
  return {
    ...result,
    outcome: 'INCONCLUSIVE',
    errorMessageSafe: '감시 PC의 외부 연결 이상이 의심되어 대상 상태를 확인할 수 없습니다.',
  };
}
