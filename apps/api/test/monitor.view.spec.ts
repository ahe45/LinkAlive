import { describe, expect, it } from 'vitest';

import { toCheckResultView } from '../src/monitors/monitor.view.js';

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
