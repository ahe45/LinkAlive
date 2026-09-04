export { DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON } from '@linkalive/database';

export type PriorDownStatus = 'READY' | 'WAIT' | 'CANCEL';

/** Enforces that a recovery can never overtake its channel's DOWN event. */
export function recoveryPrerequisiteStatus(status: string | null): PriorDownStatus {
  if (status === 'SENT') return 'READY';
  if (status === null || status === 'FAILED' || status === 'CANCELED') return 'CANCEL';
  return 'WAIT';
}
