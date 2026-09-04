import { createHash } from 'node:crypto';

import type { RenderedNotification, SafeNotificationPayload } from './types.js';

const MAX_NAME_LENGTH = 160;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const MAX_TELEGRAM_LENGTH = 4_096;
const MAX_MESSAGE_ID_DOMAIN_LENGTH = 253;

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeDisplayUrl(value: unknown): string {
  if (typeof value !== 'string') return '(URL 숨김)';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '(URL 숨김)';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_000);
  } catch {
    return '(URL 숨김)';
  }
}

function safeDashboardUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_000);
  } catch {
    return null;
  }
}

function eventLabel(eventType: SafeNotificationPayload['eventType']): string {
  if (eventType === 'DOWN') return '장애 발생';
  if (eventType === 'RECOVERY') return '복구 완료';
  if (eventType === 'RESOLVED_SUMMARY') return '장애 및 복구 요약';
  return '시험 알림';
}

function formatDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '확인 불가' : date.toISOString();
}

function formatDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}분 ${remainingSeconds}초`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

function truncateTelegram(text: string): string {
  if (text.length <= MAX_TELEGRAM_LENGTH) return text;
  return `${text.slice(0, MAX_TELEGRAM_LENGTH - 2_000)}\n… 내용이 길어 관리 화면에서 확인해 주세요.`;
}

export function renderNotification(payload: SafeNotificationPayload): RenderedNotification {
  const label = eventLabel(payload.eventType);
  const monitorName = cleanText(payload.monitorName, MAX_NAME_LENGTH) || '이름 없는 모니터';
  const displayUrl = sanitizeDisplayUrl(payload.displayUrl);
  const occurredAt = formatDate(payload.occurredAt);
  const errorType = cleanText(payload.errorType, 80);
  const errorMessage = cleanText(payload.errorMessageSafe, MAX_SAFE_MESSAGE_LENGTH);
  const dashboardUrl = safeDashboardUrl(payload.dashboardUrl);
  const duration = formatDuration(payload.durationMs);
  const rows: Array<[string, string]> = [
    ['모니터', monitorName],
    ['대상', displayUrl],
    ['시각', occurredAt],
  ];
  if (errorType) rows.push(['오류 유형', errorType]);
  if (errorMessage) rows.push(['설명', errorMessage]);
  if (typeof payload.statusCode === 'number') rows.push(['HTTP 상태', String(payload.statusCode)]);
  if (typeof payload.ttfbMs === 'number' && Number.isFinite(payload.ttfbMs)) {
    rows.push(['응답 시간', `${Math.max(0, Math.round(payload.ttfbMs))}ms`]);
  }
  if (duration) rows.push(['장애 지속', duration]);

  const textLines = [`LinkAlive ${label}`, '', ...rows.map(([key, value]) => `${key}: ${value}`)];
  if (dashboardUrl) textLines.push('', `관리 화면: ${dashboardUrl}`);
  const text = textLines.join('\n');
  return { telegramText: truncateTelegram(text) };
}

export function createStableMessageId(dedupeKey: string, domain = 'linkalive.local'): string {
  const digest = createHash('sha256').update(dedupeKey, 'utf8').digest('hex').slice(0, 40);
  const normalizedDomain = domain
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, MAX_MESSAGE_ID_DOMAIN_LENGTH)
    .replace(/\.+$/g, '');
  const safeDomain = normalizedDomain || 'linkalive.local';
  return `<linkalive-${digest}@${safeDomain}>`;
}
