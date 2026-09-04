import {
  NotificationEventType,
  NotificationOutboxStatus,
  type NotificationEventType as NotificationEventTypeValue,
  type NotificationOutboxStatus as NotificationOutboxStatusValue,
} from './types.js';

export interface NotificationDedupeParts {
  incidentId: string;
  channelId: string;
  eventType: Exclude<NotificationEventTypeValue, 'TEST'>;
}

function requireIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RangeError(`${name} cannot be empty`);
  }
  return normalized;
}

/** Builds the DB idempotency key without including destination secrets. */
export function createNotificationDedupeKey(parts: NotificationDedupeParts): string {
  const incidentId = requireIdentifier(parts.incidentId, 'incidentId');
  const channelId = requireIdentifier(parts.channelId, 'channelId');
  return `incident:${encodeURIComponent(incidentId)}:channel:${encodeURIComponent(channelId)}:event:${parts.eventType}`;
}

export function createTestNotificationDedupeKey(options: {
  channelId: string;
  requestId: string;
}): string {
  const channelId = requireIdentifier(options.channelId, 'channelId');
  const requestId = requireIdentifier(options.requestId, 'requestId');
  return `channel:${encodeURIComponent(channelId)}:test:${encodeURIComponent(requestId)}`;
}

/** Sequence is scoped to an incident/channel pair. */
export function notificationSequence(eventType: NotificationEventTypeValue): number {
  switch (eventType) {
    case NotificationEventType.DOWN:
      return 1;
    case NotificationEventType.RECOVERY:
    case NotificationEventType.RESOLVED_SUMMARY:
      return 2;
    case NotificationEventType.TEST:
      return 1;
  }
}

export type RecoveryNotificationPlan =
  | { action: 'CREATE_RECOVERY'; waitForDownTerminalState: boolean }
  | { action: 'REPLACE_WITH_RESOLVED_SUMMARY' }
  | { action: 'SKIP'; reason: 'DOWN_NOT_DELIVERED' };

/**
 * Encodes the per-channel recovery ordering policy. This only plans DB events;
 * dispatchers must still lock rows and enforce sequence ordering atomically.
 */
export function planRecoveryNotification(options: {
  downStatus: NotificationOutboxStatusValue;
  downAttemptCount: number;
}): RecoveryNotificationPlan {
  if (!Number.isSafeInteger(options.downAttemptCount) || options.downAttemptCount < 0) {
    throw new RangeError('downAttemptCount must be a non-negative safe integer');
  }

  if (
    options.downAttemptCount === 0 &&
    (options.downStatus === NotificationOutboxStatus.PENDING ||
      options.downStatus === NotificationOutboxStatus.ENQUEUED)
  ) {
    return { action: 'REPLACE_WITH_RESOLVED_SUMMARY' };
  }

  if (
    options.downStatus === NotificationOutboxStatus.FAILED ||
    options.downStatus === NotificationOutboxStatus.CANCELED
  ) {
    return { action: 'SKIP', reason: 'DOWN_NOT_DELIVERED' };
  }

  return {
    action: 'CREATE_RECOVERY',
    waitForDownTerminalState: options.downStatus !== NotificationOutboxStatus.SENT,
  };
}
