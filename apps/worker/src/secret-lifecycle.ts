import {
  IncidentStatus,
  NotificationEventType,
  NotificationOutboxStatus,
  secretTombstoneBytes,
  type IncidentStatus as IncidentStatusValue,
  type NotificationEventType as NotificationEventTypeValue,
  type NotificationOutboxStatus as NotificationOutboxStatusValue,
} from '@linkalive/database';

import { DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON } from './notification-order.js';

const TERMINAL_STATUSES = new Set<NotificationOutboxStatusValue>([
  NotificationOutboxStatus.SENT,
  NotificationOutboxStatus.FAILED,
  NotificationOutboxStatus.CANCELED,
]);

export interface NotificationSecretState {
  status: NotificationOutboxStatusValue;
  eventType: NotificationEventTypeValue;
  lastErrorSafe?: string | null;
  payloadAllowsRecovery?: boolean;
  incidentStatus?: IncidentStatusValue | null;
}

/**
 * Returns true only while a persisted destination can still be needed.
 *
 * A SENT DOWN for an open incident is the source snapshot for its future
 * recovery. A recovery canceled because DOWN was not confirmed must also be
 * kept: a provider-confirmed late DOWN attempt can atomically reactivate it.
 */
export function shouldRetainNotificationSecret(state: NotificationSecretState): boolean {
  if (!TERMINAL_STATUSES.has(state.status)) return true;
  if (
    state.eventType === NotificationEventType.RECOVERY &&
    state.status === NotificationOutboxStatus.CANCELED &&
    state.lastErrorSafe === DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON
  ) {
    return true;
  }
  return (
    state.eventType === NotificationEventType.DOWN &&
    state.status === NotificationOutboxStatus.SENT &&
    state.payloadAllowsRecovery === true &&
    state.incidentStatus === IncidentStatus.OPEN
  );
}

export function retiredNotificationSecretData(): {
  encryptedConfigSnapshot: Uint8Array<ArrayBuffer>;
} {
  return { encryptedConfigSnapshot: secretTombstoneBytes() };
}
