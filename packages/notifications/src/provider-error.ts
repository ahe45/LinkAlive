export class NotificationProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly deliveryUncertain: boolean;
  readonly safeMessage: string;
  readonly retryAfterMs: number | null;

  constructor(options: {
    code: string;
    retryable: boolean;
    deliveryUncertain?: boolean;
    retryAfterMs?: number;
    safeMessage: string;
    cause?: unknown;
  }) {
    // Provider errors can contain chat IDs or a Telegram bot URL.
    // Keep only the allow-listed operational classification on this object.
    super(options.safeMessage);
    this.name = 'NotificationProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.deliveryUncertain = options.deliveryUncertain ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.safeMessage = options.safeMessage;
  }
}
