import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { getConfig } from '../common/config.js';
import { IS_PUBLIC_ROUTE } from './public.decorator.js';
import { verifySessionToken } from './session.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const config = getConfig();
    const token = request.cookies?.[config.authCookieName];
    const payload = token ? verifySessionToken(token, config.authSecret) : null;
    if (!payload || payload.sub !== config.adminUsername)
      throw new UnauthorizedException('로그인이 필요합니다.');

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && !config.webOrigins.includes(origin.replace(/\/$/, ''))) {
        throw new ForbiddenException('허용되지 않은 요청 출처입니다.');
      }
    }

    (request as FastifyRequest & { user: SessionPayload }).user = payload;
    return true;
  }
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}
