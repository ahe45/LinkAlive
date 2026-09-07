import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountRole, prisma } from '@linkalive/database';
import type { FastifyRequest } from 'fastify';
import { getConfig } from '../common/config.js';
import { ADMIN_ONLY } from './admin-only.decorator.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { IS_PUBLIC_ROUTE } from './public.decorator.js';
import { verifySessionToken } from './session.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const config = getConfig();
    const token = request.cookies?.[config.authCookieName];
    const payload = token ? verifySessionToken(token, config.authSecret) : null;
    if (!payload) throw new UnauthorizedException('로그인이 필요합니다.');

    const account = await prisma.account.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, role: true, enabled: true },
    });
    if (!account?.enabled) throw new UnauthorizedException('로그인이 필요합니다.');

    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (adminOnly && account.role !== AccountRole.ADMIN) {
      throw new ForbiddenException('관리자 권한이 필요합니다.');
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && !config.webOrigins.includes(origin.replace(/\/$/, ''))) {
        throw new ForbiddenException('허용되지 않은 요청 출처입니다.');
      }
    }

    (request as AuthenticatedRequest).user = {
      id: account.id,
      username: account.username,
      role: account.role,
    };
    return true;
  }
}
