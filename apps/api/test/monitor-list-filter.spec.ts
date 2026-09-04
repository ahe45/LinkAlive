import { describe, expect, it } from 'vitest';

import { buildMonitorListWhere } from '../src/monitors/monitors.service.js';

const now = new Date('2026-09-03T00:10:00.000Z');

describe('monitor list filters', () => {
  it.each(['DOWN', 'RECOVERING'] as const)(
    'keeps stale %s monitors in their incident-state filter',
    (state) => {
      expect(buildMonitorListWhere(state, undefined, now)).toEqual({
        AND: [
          { deletedAt: null },
          {
            lifecycleStatus: 'ACTIVE',
            healthState: state,
          },
        ],
      });
    },
  );

  it('queries a broad STALE candidate set before exact interval filtering', () => {
    const where = buildMonitorListWhere('STALE', undefined, now);
    const stale = (where.AND as Array<Record<string, unknown>>)[1];

    expect(stale).toEqual({
      lifecycleStatus: 'ACTIVE',
      nextCheckAt: { lt: new Date('2026-09-03T00:05:00.000Z') },
    });
  });

  it('keeps stale independent from target health and applies search on the server', () => {
    const where = buildMonitorListWhere('UP', ' example ', now);
    const filters = where.AND as Array<Record<string, unknown>>;

    expect(filters[1]).toMatchObject({
      lifecycleStatus: 'ACTIVE',
      healthState: 'UP',
    });
    expect(filters[1]).not.toHaveProperty('NOT');
    expect(filters[2]).toEqual({
      OR: [{ name: { contains: 'example' } }, { displayUrl: { contains: 'example' } }],
    });
  });
});
