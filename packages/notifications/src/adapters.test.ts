import { describe, expect, it, vi } from 'vitest';

import { NotificationProviderError } from './provider-error.js';
import { TelegramNotificationAdapter } from './telegram.js';

const payload = {
  eventType: 'DOWN' as const,
  monitorName: 'Example',
  displayUrl: 'https://example.com/health',
  occurredAt: '2026-09-03T00:00:00.000Z',
};

describe('provider adapters', () => {
  it('sends Telegram content as JSON without parse-mode injection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = new TelegramNotificationAdapter({ fetch: fetchMock });
    const result = await adapter.send(
      payload,
      { botToken: '123456:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '-1001234567890' },
      '<stable@example.com>',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).not.toHaveProperty('parse_mode');
    expect(result.providerMessageId).toBe('42');
  });

  it('uses Telegram 429 parameters.retry_after when the header is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 37 },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    const adapter = new TelegramNotificationAdapter({ fetch: fetchMock });

    await expect(
      adapter.send(
        payload,
        { botToken: '123456:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '-1001234567890' },
        '<stable@example.com>',
      ),
    ).rejects.toMatchObject<Partial<NotificationProviderError>>({
      code: 'TELEGRAM_HTTP_429',
      retryable: true,
      retryAfterMs: 37_000,
    });
  });

  it('caps Telegram JSON retry delays and ignores oversized error bodies', async () => {
    const responses = [
      new Response(JSON.stringify({ parameters: { retry_after: 999_999 } }), { status: 429 }),
      new Response(
        JSON.stringify({ parameters: { retry_after: 1 }, padding: 'x'.repeat(70_000) }),
        { status: 429 },
      ),
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
    const adapter = new TelegramNotificationAdapter({ fetch: fetchMock });
    const send = () =>
      adapter.send(
        payload,
        { botToken: '123456:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '-1001234567890' },
        '<stable@example.com>',
      );

    await expect(send()).rejects.toMatchObject<Partial<NotificationProviderError>>({
      retryAfterMs: 15 * 60_000,
    });
    await expect(send()).rejects.toMatchObject<Partial<NotificationProviderError>>({
      retryAfterMs: null,
    });
  });
});
