import type { CheckOutcome, EffectiveHealthState, IncidentStatus } from '@/lib/types';
import { HEALTH_LABELS, INCIDENT_LABELS, OUTCOME_LABELS } from '@/lib/format';

export function StatusBadge({ state }: { state: EffectiveHealthState }) {
  return (
    <span className={`status-badge status-${state.toLowerCase()}`}>
      <span className="status-dot" />
      {HEALTH_LABELS[state]}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: CheckOutcome }) {
  return (
    <span className={`plain-badge outcome-${outcome.toLowerCase()}`}>
      {OUTCOME_LABELS[outcome]}
    </span>
  );
}

export function IncidentBadge({ status }: { status: IncidentStatus }) {
  return (
    <span className={`plain-badge incident-${status.toLowerCase()}`}>
      {INCIDENT_LABELS[status]}
    </span>
  );
}
