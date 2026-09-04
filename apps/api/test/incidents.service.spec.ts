import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  findIncident: vi.fn(),
  findNotifications: vi.fn(),
}));

vi.mock('@linkalive/database', () => ({
  NotificationDeliveryStatus: {
    FAILED: 'FAILED',
    UNKNOWN: 'UNKNOWN',
  },
  prisma: {
    incident: { findUnique: database.findIncident },
    notificationOutbox: { findMany: database.findNotifications },
  },
}));

import { IncidentsService } from '../src/incidents/incidents.service.js';

describe('incident notification delivery view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns failed and unknown attempts without message or provider identifiers', async () => {
    const detectedAt = new Date('2026-09-03T00:00:00.000Z');
    const finishedAt = new Date('2026-09-03T00:00:03.000Z');
    database.findIncident.mockResolvedValue({
      id: 'incident-1',
      monitorId: 'monitor-1',
      status: 'OPEN',
      firstFailureAt: detectedAt,
      detectedAt,
      resolvedAt: null,
      canceledAt: null,
      firstErrorType: 'REQUEST_TIMEOUT',
      lastErrorType: 'REQUEST_TIMEOUT',
      closureReason: null,
      monitor: { name: '서비스', displayUrl: 'https://example.com/health' },
    });
    database.findNotifications.mockResolvedValue([
      {
        id: 'outbox-1',
        deliveries: [
          {
            id: 'delivery-1',
            attempt: 1,
            status: 'UNKNOWN',
            errorSafe: '공급자 응답 확인 실패',
            startedAt: detectedAt,
            finishedAt,
          },
        ],
      },
    ]);

    const result = await new IncidentsService().get('incident-1');
    const notificationQuery = database.findNotifications.mock.calls[0]?.[0];
    const deliveryQuery = notificationQuery.select.deliveries;

    expect(deliveryQuery.where.status.in).toEqual(['FAILED', 'UNKNOWN']);
    expect(deliveryQuery.select).toEqual({
      id: true,
      attempt: true,
      status: true,
      errorSafe: true,
      startedAt: true,
      finishedAt: true,
    });
    expect(deliveryQuery.select).not.toHaveProperty('messageId');
    expect(deliveryQuery.select).not.toHaveProperty('providerMessageId');
    expect(result.notifications[0]?.deliveries[0]).toMatchObject({
      attempt: 1,
      status: 'UNKNOWN',
      errorSafe: '공급자 응답 확인 실패',
    });
  });
});
