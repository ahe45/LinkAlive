import { renderNotification } from './message.js';
import { NotificationProviderError } from './provider-error.js';
import type {
  NotificationAdapter,
  NotificationSendResult,
  SafeNotificationPayload,
  TelegramDestination,
} from './types.js';

export interface TelegramAdapterConfig {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const MAX_RETRY_AFTER_MS = 15 * 60_000;
const MAX_TELEGRAM_ERROR_BODY_BYTES = 64 * 1_024;

function parseRetryAfterMs(value: unknown): number | undefined {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
}

async function readBoundedTelegramError(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_ERROR_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_TELEGRAM_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}

function validateDestination(destination: TelegramDestination): void {
  if (!/^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(destination.botToken)) {
    throw new NotificationProviderError({
      code: 'INVALID_TELEGRAM_CONFIG',
      retryable: false,
      safeMessage: 'Telegram bot 설정이 올바르지 않습니다.',
    });
  }
  if (!/^-?\d{1,20}$|^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(destination.chatId)) {
    throw new NotificationProviderError({
      code: 'INVALID_TELEGRAM_DESTINATION',
      retryable: false,
      safeMessage: 'Telegram 채팅 대상이 올바르지 않습니다.',
    });
  }
}

export class TelegramNotificationAdapter implements NotificationAdapter<TelegramDestination> {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: TelegramAdapterConfig = {}) {
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async send(
    payload: SafeNotificationPayload,
    destination: TelegramDestination,
    messageId: string,
  ): Promise<NotificationSendResult> {
    validateDestination(destination);
    const message = renderNotification(payload);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${destination.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: destination.chatId,
            text: message.telegramText,
            disable_web_page_preview: true,
          }),
          signal,
        },
      );
    } catch (error) {
      const timedOut = signal.aborted || (error as { name?: unknown })?.name === 'AbortError';
      throw new NotificationProviderError({
        code: timedOut ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_NETWORK_ERROR',
        retryable: true,
        deliveryUncertain: timedOut,
        safeMessage: timedOut
          ? 'Telegram 응답을 확인하지 못해 전달 여부가 불확실합니다.'
          : 'Telegram 제공자와 통신하지 못했습니다.',
        cause: error,
      });
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterHeader = response.headers.get('retry-after');
      let retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      if (response.status === 429 && retryAfterMs === undefined) {
        const errorBody = await readBoundedTelegramError(response);
        if (errorBody && typeof errorBody === 'object' && !Array.isArray(errorBody)) {
          const parameters = (errorBody as { parameters?: unknown }).parameters;
          if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
            retryAfterMs = parseRetryAfterMs((parameters as { retry_after?: unknown }).retry_after);
          }
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new NotificationProviderError({
        code: `TELEGRAM_HTTP_${response.status}`,
        retryable,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        safeMessage: retryable
          ? 'Telegram 제공자가 일시적으로 요청을 처리하지 못했습니다.'
          : 'Telegram 제공자가 메시지를 거절했습니다.',
      });
    }

    let providerMessageId: string | null = null;
    try {
      const body = (await response.json()) as { ok?: unknown; result?: { message_id?: unknown } };
      if (body.ok !== true) {
        throw new Error('Unexpected Telegram response');
      }
      if (
        typeof body.result?.message_id === 'number' ||
        typeof body.result?.message_id === 'string'
      ) {
        providerMessageId = String(body.result.message_id);
      }
    } catch (error) {
      throw new NotificationProviderError({
        code: 'TELEGRAM_INVALID_RESPONSE',
        retryable: true,
        deliveryUncertain: true,
        safeMessage: 'Telegram 응답을 확인하지 못해 전달 여부가 불확실합니다.',
        cause: error,
      });
    }

    return { messageId, providerMessageId };
  }
}
