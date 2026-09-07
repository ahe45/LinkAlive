import { AccountRole } from '@linkalive/database';
import { describe, expect, it } from 'vitest';

import { toCheckResultView, toMonitorView } from '../src/monitors/monitor.view.js';

describe('check result view', () => {
  it('returns the safe URL snapshot for a pre-save test result without a monitor', () => {
    const startedAt = new Date('2026-09-03T00:00:00.000Z');
    const finishedAt = new Date('2026-09-03T00:00:00.125Z');

    expect(
      toCheckResultView({
        id: '0c524461-286a-4287-8889-a59b89e4ab72',
        monitorId: null,
        configVersion: null,
        displayUrlSnapshot: 'https://example.com/health',
        source: 'TEST',
        outcome: 'SUCCESS',
        startedAt,
        finishedAt,
        statusCode: 204,
        ttfbMs: 100,
        totalMs: 125,
        errorType: null,
        errorMessageSafe: null,
      }),
    ).toMatchObject({
      monitorId: null,
      configVersion: null,
      displayUrlSnapshot: 'https://example.com/health',
      source: 'TEST',
    });
  });
});

describe('monitor view permissions', () => {
  it('returns the owner and management permission for the requesting account', () => {
    const timestamp = new Date('2026-09-07T00:00:00.000Z');
    const view = toMonitorView(
      {
        id: 'monitor-id',
        ownerAccountId: 'owner-id',
        owner: { id: 'owner-id', username: 'owner' },
        channels: [],
        name: '서비스',
        displayUrl: 'https://example.com/',
        method: 'GET',
        intervalSec: 60,
        timeoutMs: 10_000,
        expectedStatusMin: 200,
        expectedStatusMax: 299,
        expectedKeyword: null,
        followRedirects: true,
        maxRedirects: 5,
        failureThreshold: 3,
        recoveryThreshold: 2,
        lifecycleStatus: 'ACTIVE',
        healthState: 'PENDING',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        nextCheckAt: timestamp,
        lastCheckedAt: null,
        lastStatusCode: null,
        lastTtfbMs: null,
        lastTotalMs: null,
        lastErrorType: null,
        configVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      } as never,
      { id: 'owner-id', username: 'owner', role: AccountRole.USER },
    );

    expect(view.owner).toEqual({ id: 'owner-id', username: 'owner' });
    expect(view.canManage).toBe(true);
  });
});
