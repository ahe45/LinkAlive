import { describe, expect, it } from 'vitest';

import {
  createNotificationDedupeKey,
  notificationSequence,
  planRecoveryNotification,
} from './notifications.js';
import { NotificationEventType, NotificationOutboxStatus } from './types.js';

describe('notification policy', () => {
  it('builds deterministic keys for an incident/channel/event', () => {
    expect(
      createNotificationDedupeKey({
        incidentId: 'incident-1',
        channelId: 'channel-1',
        eventType: NotificationEventType.DOWN,
      }),
    ).toBe('incident:incident-1:channel:channel-1:event:DOWN');
  });

  it('orders recovery after down', () => {
    expect(notificationSequence(NotificationEventType.DOWN)).toBe(1);
    expect(notificationSequence(NotificationEventType.RECOVERY)).toBe(2);
  });

  it('collapses an unattempted down into a resolved summary', () => {
    expect(
      planRecoveryNotification({
        downStatus: NotificationOutboxStatus.PENDING,
        downAttemptCount: 0,
      }),
    ).toEqual({ action: 'REPLACE_WITH_RESOLVED_SUMMARY' });
  });

  it('sends recovery only after a down attempt can reach terminal state', () => {
    expect(
      planRecoveryNotification({
        downStatus: NotificationOutboxStatus.PROCESSING,
        downAttemptCount: 1,
      }),
    ).toEqual({
      action: 'CREATE_RECOVERY',
      waitForDownTerminalState: true,
    });
    expect(
      planRecoveryNotification({
        downStatus: NotificationOutboxStatus.SENT,
        downAttemptCount: 1,
      }),
    ).toEqual({
      action: 'CREATE_RECOVERY',
      waitForDownTerminalState: false,
    });
  });

  it('skips recovery after down permanently fails', () => {
    expect(
      planRecoveryNotification({
        downStatus: NotificationOutboxStatus.FAILED,
        downAttemptCount: 3,
      }),
    ).toEqual({ action: 'SKIP', reason: 'DOWN_NOT_DELIVERED' });
  });
});
