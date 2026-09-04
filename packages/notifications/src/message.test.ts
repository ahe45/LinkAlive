import { describe, expect, it } from 'vitest';

import { createStableMessageId, renderNotification, sanitizeDisplayUrl } from './message.js';

describe('notification messages', () => {
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
