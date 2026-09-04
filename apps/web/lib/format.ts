import type {
  CheckOutcome,
  CheckSource,
  EffectiveHealthState,
  ErrorType,
  IncidentStatus,
  Monitor,
} from '@/lib/types';

const dateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const relativeFormatter = new Intl.RelativeTimeFormat('ko-KR', { numeric: 'auto' });

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

export function formatRelativeTime(value?: string | null): string {
  if (!value) return '아직 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return relativeFormatter.format(seconds, 'second');
  if (absolute < 3600) return relativeFormatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return relativeFormatter.format(Math.round(seconds / 3600), 'hour');
  return relativeFormatter.format(Math.round(seconds / 86400), 'day');
}

export function formatDuration(milliseconds?: number | null): string {
  if (milliseconds == null) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}초`;
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}분`;
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  return `${hours}시간${minutes ? ` ${minutes}분` : ''}`;
}

export function formatInterval(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    hours ? `${hours}시간` : '',
    minutes ? `${minutes}분` : '',
    remainingSeconds ? `${remainingSeconds}초` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function effectiveMonitorState(monitor: Monitor): EffectiveHealthState {
  if (monitor.lifecycleStatus === 'PAUSED') return 'PAUSED';
  // STALE is an independent operational warning. The target's health remains
  // the primary state so a delayed scheduler never hides an outage or recovery.
  return monitor.healthState;
}

export function isMonitorStale(monitor: Monitor): boolean {
  if (monitor.lifecycleStatus !== 'ACTIVE' || !monitor.nextCheckAt) return false;
  const nextCheck = new Date(monitor.nextCheckAt).getTime();
  if (Number.isNaN(nextCheck)) return false;
  const staleWindowMs = Math.max(monitor.intervalSec * 2, 300) * 1000;
  return Date.now() > nextCheck + staleWindowMs;
}

export const HEALTH_LABELS: Record<EffectiveHealthState, string> = {
  UP: '정상',
  SUSPECT: '불안정',
  DOWN: '장애',
  RECOVERING: '복구 확인 중',
  PENDING: '확인 대기',
  STALE: '검사 지연',
  PAUSED: '일시 중지',
};

export const OUTCOME_LABELS: Record<CheckOutcome, string> = {
  SUCCESS: '성공',
  TARGET_FAILURE: '대상 오류',
  PLATFORM_ERROR: '시스템 오류',
  INCONCLUSIVE: '판정 보류',
};

export const SOURCE_LABELS: Record<CheckSource, string> = {
  SCHEDULED: '자동',
  MANUAL: '수동',
  TEST: '시험',
};

export const INCIDENT_LABELS: Record<IncidentStatus, string> = {
  OPEN: '진행 중',
  RESOLVED: '복구됨',
  CANCELED: '취소됨',
};

export const ERROR_LABELS: Record<ErrorType, string> = {
  DNS_ERROR: 'DNS 조회 오류',
  CONNECT_TIMEOUT: '연결 시간 초과',
  CONNECTION_REFUSED: '연결 거절',
  TLS_ERROR: 'TLS 인증 오류',
  TTFB_TIMEOUT: '첫 응답 시간 초과',
  REQUEST_TIMEOUT: '요청 시간 초과',
  REDIRECT_ERROR: '리다이렉트 오류',
  HTTP_STATUS_MISMATCH: '예상 외 상태 코드',
  CONTENT_MISMATCH: '응답 키워드 불일치',
  RESPONSE_LIMIT_EXCEEDED: '응답 제한 초과',
  NETWORK_ERROR: '네트워크 오류',
  PLATFORM_ERROR: 'LinkAlive 시스템 오류',
};

export function errorTypeLabel(value?: ErrorType | null): string {
  return value ? (ERROR_LABELS[value] ?? value) : '—';
}
