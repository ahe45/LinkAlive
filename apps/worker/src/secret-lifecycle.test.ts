import {
  IncidentStatus,
  NotificationEventType,
  NotificationOutboxStatus,
  isSecretTombstone,
} from '@linkalive/database';
import { describe, expect, it } from 'vitest';

import { DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON } from './notification-order.js';
import {
  retiredNotificationSecretData,
  shouldRetainNotificationSecret,
} from './secret-lifecycle.js';

describe('notification secret lifecycle', () => {
  it('keeps a sent DOWN destination only while an open incident can create recovery', () => {
    expect(
      shouldRetainNotificationSecret({
        status: NotificationOutboxStatus.SENT,
        eventType: NotificationEventType.DOWN,
        payloadAllowsRecovery: true,
        incidentStatus: IncidentStatus.OPEN,
      }),
    ).toBe(true);
    expect(
      shouldRetainNotificationSecret({
        status: NotificationOutboxStatus.SENT,
        eventType: NotificationEventType.DOWN,
        payloadAllowsRecovery: true,
        incidentStatus: IncidentStatus.RESOLVED,
      }),
    ).toBe(false);
  });

  it('keeps the specially canceled recovery for a provider-confirmed late DOWN success', () => {
    expect(
      shouldRetainNotificationSecret({
        status: NotificationOutboxStatus.CANCELED,
        eventType: NotificationEventType.RECOVERY,
        lastErrorSafe: DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
      }),
    ).toBe(true);
    expect(
      shouldRetainNotificationSecret({
        status: NotificationOutboxStatus.CANCELED,
        eventType: NotificationEventType.RECOVERY,
        lastErrorSafe: '채널 삭제',
      }),
    ).toBe(false);
  });

  it('keeps active retries and retires other terminal snapshots to non-empty bytes', () => {
    expect(
      shouldRetainNotificationSecret({
        status: NotificationOutboxStatus.RETRY,
        eventType: NotificationEventType.DOWN,
      }),
    ).toBe(true);
    expect(
      shouldRetainNotificationSecret({
        status: NotificationOutboxStatus.FAILED,
        eventType: NotificationEventType.DOWN,
      }),
    ).toBe(false);
    expect(isSecretTombstone(retiredNotificationSecretData().encryptedConfigSnapshot)).toBe(true);
    expect(retiredNotificationSecretData().encryptedConfigSnapshot.byteLength).toBeGreaterThan(0);
  });
});
