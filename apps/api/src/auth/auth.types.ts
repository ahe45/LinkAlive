import type { AccountRole } from '@linkalive/database';
import type { FastifyRequest } from 'fastify';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: AccountRole;
}

export type AuthenticatedRequest = FastifyRequest & { user: AuthenticatedUser };
