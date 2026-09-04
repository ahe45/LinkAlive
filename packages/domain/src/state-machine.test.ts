import { describe, expect, it } from 'vitest';

import {
  applyCheckResult,
  resetForConfigChange,
  transitionLifecycle,
  type MonitorState,
} from './state-machine.js';
import {
  CheckErrorType,
  CheckOutcome,
  CheckSource,
  MonitorHealth,
  MonitorLifecycle,
} from './types.js';

function pendingState(overrides: Partial<MonitorState> = {}): MonitorState {
  return {
    lifecycleStatus: MonitorLifecycle.ACTIVE,
    healthState: MonitorHealth.PENDING,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    failureStreakStartedAt: null,
    failureStreakFirstErrorType: null,
    configVersion: 1,
    ...overrides,
  };
}

function result(
  state: MonitorState,
  outcome: (typeof CheckOutcome)[keyof typeof CheckOutcome],
  checkedAt: Date,
  errorType: (typeof CheckErrorType)[keyof typeof CheckErrorType] | null = null,
) {
  return applyCheckResult(state, {
    source: CheckSource.SCHEDULED,
    outcome,
    configVersion: state.configVersion,
    checkedAt,
    errorType,
    failureThreshold: 3,
    recoveryThreshold: 2,
  });
}

describe('applyCheckResult', () => {
  it('moves through SUSPECT, DOWN, RECOVERING and UP with one incident', () => {
    const firstAt = new Date('2026-09-03T00:00:00.000Z');
    const secondAt = new Date('2026-09-03T00:01:00.000Z');
    const detectedAt = new Date('2026-09-03T00:02:00.000Z');
    const recoveringAt = new Date('2026-09-03T00:03:00.000Z');
    const recoveredAt = new Date('2026-09-03T00:04:00.000Z');

    const first = result(
      pendingState(),
      CheckOutcome.TARGET_FAILURE,
      firstAt,
      CheckErrorType.DNS_ERROR,
    );
    expect(first.state.healthState).toBe(MonitorHealth.SUSPECT);
    expect(first.incidentEffect).toEqual({ type: 'NONE' });

    const second = result(
      first.state,
      CheckOutcome.TARGET_FAILURE,
      secondAt,
      CheckErrorType.CONNECT_TIMEOUT,
    );
    expect(second.state.healthState).toBe(MonitorHealth.SUSPECT);

    const down = result(
      second.state,
      CheckOutcome.TARGET_FAILURE,
      detectedAt,
      CheckErrorType.HTTP_STATUS_MISMATCH,
    );
    expect(down.state.healthState).toBe(MonitorHealth.DOWN);
    expect(down.incidentEffect).toEqual({
      type: 'OPEN',
      firstFailureAt: firstAt,
      detectedAt,
      firstErrorType: CheckErrorType.DNS_ERROR,
      lastErrorType: CheckErrorType.HTTP_STATUS_MISMATCH,
    });

    const recovering = result(down.state, CheckOutcome.SUCCESS, recoveringAt);
    expect(recovering.state.healthState).toBe(MonitorHealth.RECOVERING);
    expect(recovering.state.consecutiveFailures).toBe(0);
    expect(recovering.incidentEffect).toEqual({ type: 'NONE' });

    const recovered = result(recovering.state, CheckOutcome.SUCCESS, recoveredAt);
    expect(recovered.state.healthState).toBe(MonitorHealth.UP);
    expect(recovered.incidentEffect).toEqual({
      type: 'RESOLVE',
      resolvedAt: recoveredAt,
      reason: 'RECOVERED',
    });
  });

  it('returns DOWN when a recovering monitor fails again', () => {
    const transition = result(
      pendingState({
        healthState: MonitorHealth.RECOVERING,
        consecutiveSuccesses: 1,
      }),
      CheckOutcome.TARGET_FAILURE,
      new Date('2026-09-03T00:01:00.000Z'),
      CheckErrorType.NETWORK_ERROR,
    );

    expect(transition.state.healthState).toBe(MonitorHealth.DOWN);
    expect(transition.state.consecutiveSuccesses).toBe(0);
    expect(transition.incidentEffect).toEqual({
      type: 'UPDATE',
      lastErrorType: CheckErrorType.NETWORK_ERROR,
    });
  });

  it('supports failure and recovery thresholds of one', () => {
    const down = applyCheckResult(pendingState(), {
      source: CheckSource.SCHEDULED,
      outcome: CheckOutcome.TARGET_FAILURE,
      configVersion: 1,
      checkedAt: new Date('2026-09-03T00:00:00.000Z'),
      errorType: CheckErrorType.TLS_ERROR,
      failureThreshold: 1,
      recoveryThreshold: 1,
    });
    expect(down.state.healthState).toBe(MonitorHealth.DOWN);
    expect(down.incidentEffect.type).toBe('OPEN');

    const up = applyCheckResult(down.state, {
      source: CheckSource.SCHEDULED,
      outcome: CheckOutcome.SUCCESS,
      configVersion: 1,
      checkedAt: new Date('2026-09-03T00:01:00.000Z'),
      failureThreshold: 1,
      recoveryThreshold: 1,
    });
    expect(up.state.healthState).toBe(MonitorHealth.UP);
    expect(up.incidentEffect.type).toBe('RESOLVE');
  });

  it.each([
    {
      name: 'manual result',
      state: pendingState(),
      source: CheckSource.MANUAL,
      outcome: CheckOutcome.TARGET_FAILURE,
      configVersion: 1,
      reason: 'NON_SCHEDULED_SOURCE',
    },
    {
      name: 'old config',
      state: pendingState({ configVersion: 2 }),
      source: CheckSource.SCHEDULED,
      outcome: CheckOutcome.TARGET_FAILURE,
      configVersion: 1,
      reason: 'STALE_CONFIG_VERSION',
    },
    {
      name: 'platform error',
      state: pendingState(),
      source: CheckSource.SCHEDULED,
      outcome: CheckOutcome.PLATFORM_ERROR,
      configVersion: 1,
      reason: 'NON_TARGET_OUTCOME',
    },
    {
      name: 'paused monitor',
      state: pendingState({ lifecycleStatus: MonitorLifecycle.PAUSED }),
      source: CheckSource.SCHEDULED,
      outcome: CheckOutcome.TARGET_FAILURE,
      configVersion: 1,
      reason: 'LIFECYCLE_NOT_ACTIVE',
    },
  ])('does not mutate state for $name', (testCase) => {
    const transition = applyCheckResult(testCase.state, {
      source: testCase.source,
      outcome: testCase.outcome,
      configVersion: testCase.configVersion,
      checkedAt: new Date('2026-09-03T00:00:00.000Z'),
      failureThreshold: 3,
      recoveryThreshold: 2,
    });
    expect(transition.applied).toBe(false);
    expect(transition.ignoredReason).toBe(testCase.reason);
    expect(transition.state).toEqual(testCase.state);
  });
});

describe('administrative transitions', () => {
  it('cancels an open incident when paused', () => {
    const changedAt = new Date('2026-09-03T00:05:00.000Z');
    const transition = transitionLifecycle(
      pendingState({ healthState: MonitorHealth.DOWN }),
      MonitorLifecycle.PAUSED,
      changedAt,
    );

    expect(transition.state.lifecycleStatus).toBe(MonitorLifecycle.PAUSED);
    expect(transition.state.healthState).toBe(MonitorHealth.PENDING);
    expect(transition.incidentEffect).toEqual({
      type: 'CANCEL',
      canceledAt: changedAt,
      reason: 'PAUSED',
    });
  });

  it('increments config version, resets counters and cancels an incident', () => {
    const changedAt = new Date('2026-09-03T00:05:00.000Z');
    const transition = resetForConfigChange(
      pendingState({
        healthState: MonitorHealth.RECOVERING,
        consecutiveSuccesses: 1,
        configVersion: 4,
      }),
      changedAt,
    );

    expect(transition.state).toMatchObject({
      healthState: MonitorHealth.PENDING,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      configVersion: 5,
    });
    expect(transition.incidentEffect).toMatchObject({
      type: 'CANCEL',
      reason: 'CONFIG_CHANGED',
    });
  });
});
