import { describe, expect, it } from 'vitest';

import { createStableMessageId, renderNotification, sanitizeDisplayUrl } from './message.js';

describe('notification messages', () => {
  it('renders a PC connectivity summary separately from a target recovery', () => {
    const message = renderNotification({
      eventType: 'NETWORK_RECOVERY',
      monitorName: 'monitor-pc',
      displayUrl: '(감시 PC 외부 연결)',
      occurredAt: '2026-09-09T04:22:00Z',
      networkStartedAt: '2026-09-09T04:20:00Z',
      durationMs: 120_000,
      errorMessageSafe: '대상 재검사: 정상 응답 1개, 확인 대기 0개.',
    }).telegramText;
    expect(message).toContain('LinkAlive 감시 PC 외부 연결 복구');
    expect(message).toContain('감시 PC: monitor-pc');
    expect(message).toContain('연결 이상 감지: 2026-09-09 13:20:00 (KST)');
    expect(message).toContain('시각: 2026-09-09 13:22:00 (KST)');
    expect(message).toContain('연결 확인 불가 시간: 2분 0초');
    expect(message).not.toContain('장애 지속');
  });
  it.each([
    ['2026-09-09T04:20:09.760Z', '2026-09-09 13:20:09 (KST)'],
    [new Date('2026-09-09T04:20:09.760Z'), '2026-09-09 13:20:09 (KST)'],
    ['2026-12-31T15:00:00.000Z', '2027-01-01 00:00:00 (KST)'],
    ['2026-09-09T13:20:09+09:00', '2026-09-09 13:20:09 (KST)'],
    ['invalid', '확인 불가'],
  ])('formats notification time %s in Korea time', (occurredAt, expected) => {
    const rendered = renderNotification({
      eventType: 'DOWN',
      monitorName: '시간 표시 확인',
      displayUrl: 'https://example.com',
      occurredAt,
    });
    expect(rendered.telegramText).toContain(`시각: ${expected}`);
  });

  it('removes URL credentials, query values and fragments', () => {
    expect(sanitizeDisplayUrl('https://user:pass@example.com/path?token=secret#x')).toBe(
      'https://example.com/path',
    );
  });

  it('renders plain Telegram text without response or query secrets', () => {
    const rendered = renderNotification({
      eventType: 'DOWN',
      monitorName: '<img src=x onerror=alert(1)>',
      displayUrl: 'https://example.com/health?apiKey=very-secret',
      occurredAt: new Date('2026-09-03T00:00:00Z'),
      errorType: 'HTTP_STATUS_MISMATCH',
      errorMessageSafe: 'service unavailable',
    });
    expect(rendered.telegramText).toContain('<img');
    expect(JSON.stringify(rendered)).not.toContain('very-secret');
  });

  it('uses a deterministic Message-ID for all retries', () => {
    const first = createStableMessageId('incident-1:channel-1:DOWN', 'alerts.example.com');
    const retry = createStableMessageId('incident-1:channel-1:DOWN', 'alerts.example.com');
    const other = createStableMessageId('incident-1:channel-1:RECOVERY', 'alerts.example.com');
    expect(first).toBe(retry);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^<linkalive-[a-f0-9]+@alerts\.example\.com>$/);
  });

  it('bounds an untrusted Message-ID domain to a database-safe length', () => {
    const messageId = createStableMessageId('dedupe-key', `${'a'.repeat(1_000)}.example.com`);
    expect(messageId.length).toBeLessThanOrEqual(512);
    expect(messageId).toMatch(/^<linkalive-[a-f0-9]+@[a-z0-9.-]+>$/);
  });

  it('renders a dedicated test-notification label', () => {
    const rendered = renderNotification({
      eventType: 'TEST',
      monitorName: '알림 채널 시험',
      displayUrl: 'https://example.com',
      occurredAt: '2026-09-03T00:00:00.000Z',
    });
    expect(rendered.telegramText).toContain('시험 알림');
  });
});
