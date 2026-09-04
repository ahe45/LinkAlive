import type { CheckErrorType, CheckOutcome } from './types.js';

export class CheckFailure extends Error {
  readonly outcome: CheckOutcome;
  readonly errorType: CheckErrorType;
  readonly safeMessage: string;

  constructor(
    outcome: CheckOutcome,
    errorType: CheckErrorType,
    safeMessage: string,
    options?: ErrorOptions,
  ) {
    // Never retain the raw network error: it may embed the original URL query
    // or other destination details that must not reach application logs.
    super(safeMessage);
    void options;
    this.name = 'CheckFailure';
    this.outcome = outcome;
    this.errorType = errorType;
    this.safeMessage = safeMessage;
  }
}

export class UrlPolicyError extends CheckFailure {
  constructor(safeMessage: string, options?: ErrorOptions) {
    super('INCONCLUSIVE', 'DNS_ERROR', safeMessage, options);
    this.name = 'UrlPolicyError';
  }
}

export class RedirectPolicyError extends CheckFailure {
  constructor(safeMessage: string, options?: ErrorOptions) {
    super('TARGET_FAILURE', 'REDIRECT_ERROR', safeMessage, options);
    this.name = 'RedirectPolicyError';
  }
}

export class DestinationLimiterError extends CheckFailure {
  constructor(safeMessage: string) {
    super('PLATFORM_ERROR', 'PLATFORM_ERROR', safeMessage);
    this.name = 'DestinationLimiterError';
  }
}

export function abortError(reason = '요청 제한 시간이 초과되었습니다.'): CheckFailure {
  return new CheckFailure('TARGET_FAILURE', 'REQUEST_TIMEOUT', reason);
}
