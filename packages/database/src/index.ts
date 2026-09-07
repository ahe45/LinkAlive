export * from '@prisma/client';
export { prisma } from './client.js';
export { hashAccountPassword, verifyAccountPassword } from './account-password.js';
export {
  DOWN_NOT_DELIVERED_RECOVERY_CANCEL_REASON,
  isSecretTombstone,
  SECRET_TOMBSTONE_TEXT,
  secretTombstoneBytes,
} from './secret-tombstone.js';

import type { Prisma } from '@prisma/client';

export type TransactionClient = Prisma.TransactionClient;
