import { ForbiddenException } from '@nestjs/common';
import { AccountRole } from '@linkalive/database';
import type { AuthenticatedUser } from '../auth/auth.types.js';

export function canManageMonitor(ownerAccountId: string | null, actor: AuthenticatedUser): boolean {
  return actor.role === AccountRole.ADMIN || ownerAccountId === actor.id;
}

export function assertCanManageMonitor(
  ownerAccountId: string | null,
  actor: AuthenticatedUser,
): void {
  if (!canManageMonitor(ownerAccountId, actor)) {
    throw new ForbiddenException('이 모니터를 수정하거나 삭제할 권한이 없습니다.');
  }
}
