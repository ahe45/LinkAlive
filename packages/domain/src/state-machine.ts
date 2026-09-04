import {
  CheckOutcome,
  CheckSource,
  IncidentClosureReason,
  MonitorHealth,
  MonitorLifecycle,
  type CheckErrorType,
  type CheckOutcome as CheckOutcomeValue,
  type CheckSource as CheckSourceValue,
  type IncidentClosureReason as IncidentClosureReasonValue,
  type MonitorHealth as MonitorHealthValue,
  type MonitorLifecycle as MonitorLifecycleValue,
} from './types.js';

export interface MonitorState {
  lifecycleStatus: MonitorLifecycleValue;
  healthState: MonitorHealthValue;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failureStreakStartedAt: Date | null;
  failureStreakFirstErrorType: CheckErrorType | null;
  configVersion: number;
}

export interface CheckTransitionInput {
  source: CheckSourceValue;
  outcome: CheckOutcomeValue;
  configVersion: number;
  checkedAt: Date;
  errorType?: CheckErrorType | null;
  failureThreshold: number;
  recoveryThreshold: number;
}

export type IgnoredCheckReason =
  'LIFECYCLE_NOT_ACTIVE' | 'NON_SCHEDULED_SOURCE' | 'STALE_CONFIG_VERSION' | 'NON_TARGET_OUTCOME';

export type IncidentEffect =
  | { type: 'NONE' }
  | {
      type: 'OPEN';
      firstFailureAt: Date;
      detectedAt: Date;
      firstErrorType: CheckErrorType | null;
      lastErrorType: CheckErrorType | null;
    }
  | { type: 'UPDATE'; lastErrorType: CheckErrorType | null }
  | { type: 'RESOLVE'; resolvedAt: Date; reason: 'RECOVERED' }
  | {
      type: 'CANCEL';
      canceledAt: Date;
      reason: Exclude<IncidentClosureReasonValue, 'RECOVERED'>;
    };

export interface StateTransitionResult {
  applied: boolean;
  ignoredReason: IgnoredCheckReason | null;
  previousHealthState: MonitorHealthValue;
  state: MonitorState;
  healthChanged: boolean;
  incidentEffect: IncidentEffect;
}

function assertState(state: MonitorState): void {
  if (!Number.isSafeInteger(state.configVersion) || state.configVersion < 1) {
    throw new RangeError('configVersion must be a positive safe integer');
  }

  if (
    !Number.isSafeInteger(state.consecutiveFailures) ||
    state.consecutiveFailures < 0 ||
    !Number.isSafeInteger(state.consecutiveSuccesses) ||
    state.consecutiveSuccesses < 0
  ) {
    throw new RangeError('consecutive counters must be non-negative safe integers');
  }
}

function assertTransitionInput(input: CheckTransitionInput): void {
  if (!Number.isSafeInteger(input.failureThreshold) || input.failureThreshold < 1) {
    throw new RangeError('failureThreshold must be a positive safe integer');
  }

  if (!Number.isSafeInteger(input.recoveryThreshold) || input.recoveryThreshold < 1) {
    throw new RangeError('recoveryThreshold must be a positive safe integer');
  }

  if (!Number.isSafeInteger(input.configVersion) || input.configVersion < 1) {
    throw new RangeError('result configVersion must be a positive safe integer');
  }

  if (Number.isNaN(input.checkedAt.getTime())) {
    throw new RangeError('checkedAt must be a valid date');
  }
}

function unchanged(state: MonitorState, reason: IgnoredCheckReason): StateTransitionResult {
  return {
    applied: false,
    ignoredReason: reason,
    previousHealthState: state.healthState,
    state: { ...state },
    healthChanged: false,
    incidentEffect: { type: 'NONE' },
  };
}

/**
 * Applies the health-state rules for a single persisted check result.
 *
 * This function deliberately does no I/O. Callers must still serialize updates
 * in a database transaction and enforce one result per scheduled check.
 */
export function applyCheckResult(
  state: MonitorState,
  input: CheckTransitionInput,
): StateTransitionResult {
  assertState(state);
  assertTransitionInput(input);

  if (state.lifecycleStatus !== MonitorLifecycle.ACTIVE) {
    return unchanged(state, 'LIFECYCLE_NOT_ACTIVE');
  }

  if (input.source !== CheckSource.SCHEDULED) {
    return unchanged(state, 'NON_SCHEDULED_SOURCE');
  }

  if (input.configVersion !== state.configVersion) {
    return unchanged(state, 'STALE_CONFIG_VERSION');
  }

  if (input.outcome !== CheckOutcome.SUCCESS && input.outcome !== CheckOutcome.TARGET_FAILURE) {
    return unchanged(state, 'NON_TARGET_OUTCOME');
  }

  const previousHealthState = state.healthState;
  let next: MonitorState;
  let incidentEffect: IncidentEffect = { type: 'NONE' };

  if (input.outcome === CheckOutcome.SUCCESS) {
    const consecutiveSuccesses = state.consecutiveSuccesses + 1;
    const isRecoveringFromIncident =
      state.healthState === MonitorHealth.DOWN || state.healthState === MonitorHealth.RECOVERING;
    const recovered = isRecoveringFromIncident && consecutiveSuccesses >= input.recoveryThreshold;

    next = {
      ...state,
      healthState: isRecoveringFromIncident
        ? recovered
          ? MonitorHealth.UP
          : MonitorHealth.RECOVERING
        : MonitorHealth.UP,
      consecutiveFailures: 0,
      consecutiveSuccesses,
      failureStreakStartedAt: null,
      failureStreakFirstErrorType: null,
    };

    if (recovered) {
      incidentEffect = {
        type: 'RESOLVE',
        resolvedAt: input.checkedAt,
        reason: IncidentClosureReason.RECOVERED,
      };
    }
  } else {
    const consecutiveFailures = state.consecutiveFailures + 1;
    const failureStreakStartedAt =
      state.consecutiveFailures > 0 && state.failureStreakStartedAt !== null
        ? state.failureStreakStartedAt
        : input.checkedAt;
    const failureStreakFirstErrorType =
      state.consecutiveFailures > 0 ? state.failureStreakFirstErrorType : (input.errorType ?? null);
    const alreadyIncident =
      state.healthState === MonitorHealth.DOWN || state.healthState === MonitorHealth.RECOVERING;
    const entersDown = alreadyIncident || consecutiveFailures >= input.failureThreshold;

    next = {
      ...state,
      healthState: entersDown ? MonitorHealth.DOWN : MonitorHealth.SUSPECT,
      consecutiveFailures,
      consecutiveSuccesses: 0,
      failureStreakStartedAt,
      failureStreakFirstErrorType,
    };

    if (alreadyIncident) {
      incidentEffect = {
        type: 'UPDATE',
        lastErrorType: input.errorType ?? null,
      };
    } else if (entersDown) {
      incidentEffect = {
        type: 'OPEN',
        firstFailureAt: failureStreakStartedAt,
        detectedAt: input.checkedAt,
        firstErrorType: failureStreakFirstErrorType,
        lastErrorType: input.errorType ?? null,
      };
    }
  }

  return {
    applied: true,
    ignoredReason: null,
    previousHealthState,
    state: next,
    healthChanged: previousHealthState !== next.healthState,
    incidentEffect,
  };
}

export interface AdministrativeTransitionResult {
  state: MonitorState;
  incidentEffect: IncidentEffect;
}

/** Applies pause, resume, and soft-delete semantics. DELETED is irreversible. */
export function transitionLifecycle(
  state: MonitorState,
  lifecycleStatus: MonitorLifecycleValue,
  changedAt: Date,
): AdministrativeTransitionResult {
  assertState(state);
  if (Number.isNaN(changedAt.getTime())) {
    throw new RangeError('changedAt must be a valid date');
  }
  if (
    state.lifecycleStatus === MonitorLifecycle.DELETED &&
    lifecycleStatus !== MonitorLifecycle.DELETED
  ) {
    throw new Error('a deleted monitor cannot transition to another lifecycle state');
  }

  if (state.lifecycleStatus === lifecycleStatus) {
    return { state: { ...state }, incidentEffect: { type: 'NONE' } };
  }

  const hadOpenIncident =
    state.healthState === MonitorHealth.DOWN || state.healthState === MonitorHealth.RECOVERING;
  const reason =
    lifecycleStatus === MonitorLifecycle.DELETED
      ? IncidentClosureReason.DELETED
      : IncidentClosureReason.PAUSED;

  return {
    state: {
      ...state,
      lifecycleStatus,
      healthState: MonitorHealth.PENDING,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failureStreakStartedAt: null,
      failureStreakFirstErrorType: null,
    },
    incidentEffect:
      hadOpenIncident && lifecycleStatus !== MonitorLifecycle.ACTIVE
        ? { type: 'CANCEL', canceledAt: changedAt, reason }
        : { type: 'NONE' },
  };
}

/** Resets health meaning after a URL/request/assertion change. */
export function resetForConfigChange(
  state: MonitorState,
  changedAt: Date,
  nextConfigVersion = state.configVersion + 1,
): AdministrativeTransitionResult {
  assertState(state);
  if (Number.isNaN(changedAt.getTime())) {
    throw new RangeError('changedAt must be a valid date');
  }
  if (!Number.isSafeInteger(nextConfigVersion) || nextConfigVersion <= state.configVersion) {
    throw new RangeError('nextConfigVersion must be greater than configVersion');
  }

  const hadOpenIncident =
    state.healthState === MonitorHealth.DOWN || state.healthState === MonitorHealth.RECOVERING;

  return {
    state: {
      ...state,
      healthState: MonitorHealth.PENDING,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      failureStreakStartedAt: null,
      failureStreakFirstErrorType: null,
      configVersion: nextConfigVersion,
    },
    incidentEffect: hadOpenIncident
      ? {
          type: 'CANCEL',
          canceledAt: changedAt,
          reason: IncidentClosureReason.CONFIG_CHANGED,
        }
      : { type: 'NONE' },
  };
}
